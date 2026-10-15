/**
 * Remote-op application + echo suppression — Phase 3 (storage/03-outbox).
 *
 * When a remote op (pulled from the sync server by the Phase 4 sync loop) is
 * applied to THIS machine's local store, it must NOT itself enqueue a new
 * outbound op — otherwise the change would echo back to the server and loop
 * forever. This module owns the in-memory half of that guarantee (spec 1.4):
 *
 *   LAYER 1 (in-memory, this module) — `applyRemoteOp` runs its whole body
 *   inside an `AsyncLocalStorage` scope tagged `{ remote: true }`. Every write
 *   routine (createFile / updateFile / addTags / ...) checks `inRemoteApply()`
 *   and, when true, persists its change to DB + disk but SKIPS `enqueueOp`.
 *   Because `AsyncLocalStorage` propagates across `await`s, the tag is visible
 *   to every routine reached during the apply, including nested ones.
 *
 *   LAYER 2 (disk, the watcher) — when a remote apply touches a file on disk,
 *   chokidar fires. The watcher compares the file's SHA-256 against
 *   `files.content_hash`; because the apply updates the hash in the DB before
 *   writing the file, the watcher sees hash-equality and aborts without
 *   enqueueing an echo op. (Owned by watcher/index.ts, not this module.)
 *
 * M58 implements the complete `applyRemoteOp` dispatch and write logic for
 * all 15 {@link OpKind}s, executing all local writes within `applyScope`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { parseOp, type Op } from "./op.js";
import { getDatabase } from "../db/index.js";
import { withLock, fileLockKey } from "../util/safety.js";
import { acquireSyncLock, releaseSyncLock, withSyncLock, type WithSyncLockOptions } from "./locks.js";
import { addTags, removeTags, setFavorite, unregisterProject } from "../metadata/index.js";
import {
  createEntity,
  updateEntity,
  deleteEntity,
  linkEntities,
  unlinkEntities,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../calendar/repository.js";
import { upsertJournalMeta } from "../journal/repository.js";
import { createFolder, deleteFolder } from "../files/index.js";

/**
 * Options for {@link applyRemoteOp}.
 */
export interface ApplyRemoteOpOptions {
  db?: Database;
  lockTimeoutMs?: number;
  lockRetryIntervalMs?: number;
  lockLeaseMs?: number;
}

/**
 * The store carried by the remote-apply scope. `remote` is the literal `true`:
 * the scope only ever exists while a remote op is being applied, so a defined
 * store already means "we are in a remote apply". The boolean is kept explicit
 * so write routines can read `applyScope.getStore()?.remote` exactly as the
 * spec (1.4) writes it.
 */
export interface ApplyScopeStore {
  remote: true;
}

/**
 * The AsyncLocalStorage that tags an execution context as a remote apply.
 *
 * Exported by name so callers and tests can use it exactly as the spec does —
 * `applyScope.run({ remote: true }, fn)` / `applyScope.getStore()?.remote` — but
 * prefer {@link runInApplyScope} (to enter) and {@link inRemoteApply} (to check).
 * `getStore()` returns the store inside a scope and `undefined` outside one.
 */
export const applyScope = new AsyncLocalStorage<ApplyScopeStore>();

/**
 * Run `fn` inside a remote-apply scope. The `{ remote: true }` store is visible
 * to `fn` and to every promise `fn` (transitively) awaits, via
 * {@link inRemoteApply}.
 *
 * Returns whatever `fn` returns, so callers can `await runInApplyScope(async ()
 * => {...})`. The store type is fixed to `{ remote: true }` — this scope is only
 * ever entered for a remote apply (a local write never runs in it).
 */
export function runInApplyScope<T>(fn: () => T): T {
  return applyScope.run({ remote: true }, fn);
}

/**
 * True iff the current execution context is a remote apply.
 *
 * This is the check every write routine inserts before `enqueueOp` (M54–M57):
 * when a change was driven by a remote op rather than a local user/agent edit,
 * the routine persists it to DB + disk but must NOT enqueue an outbound op.
 * Outside a scope — the normal local-write path — this is `false`.
 */
export function inRemoteApply(): boolean {
  return applyScope.getStore()?.remote === true;
}

/** Compute SHA-256 hash of content string. */
function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Apply a remote {@link Op} to the local store.
 *
 * Validates the op (fail closed — a malformed op is never applied) and runs
 * the per-kind dispatch inside the remote-apply scope, so every write reached
 * during the apply is echo-suppressed (layer 1).
 *
 * Acquires a cross-process advisory lock on `sync_locks(gid)` for the duration
 * of the apply to guarantee two-process concurrency safety (spec 1.5).
 *
 * For file mutations, updates the DB content_hash before writing to disk,
 * satisfying the layer-2 watcher hash gating guarantee (spec 1.4).
 *
 * @throws if `op` is not a well-formed Op (per {@link parseOp}).
 */
export async function applyRemoteOp(
  op: Op,
  dbOrOptions?: Database | ApplyRemoteOpOptions,
): Promise<void> {
  const normalized = parseOp(op);
  if (normalized === null) {
    throw new Error("applyRemoteOp: refusing to apply a malformed op");
  }

  const options: ApplyRemoteOpOptions =
    dbOrOptions && typeof dbOrOptions === "object" && "prepare" in dbOrOptions
      ? { db: dbOrOptions as Database }
      : ((dbOrOptions as ApplyRemoteOpOptions) ?? {});

  const db = options.db ?? getDatabase();

  await withSyncLock(
    normalized.gid,
    async () => {
      // Echo suppression, layer 1 (spec 1.4): every write reached below sees
      // inRemoteApply() === true and skips enqueueOp.
      await runInApplyScope(async () => {
        await dispatchOp(normalized, db);
      });
    },
    {
      db,
      leaseMs: options.lockLeaseMs,
      timeoutMs: options.lockTimeoutMs,
      retryIntervalMs: options.lockRetryIntervalMs,
    },
  );
}

/**
 * Per-kind application dispatch — routes each {@link OpKind} to its local write handler.
 */
async function dispatchOp(op: Op, db: Database): Promise<void> {
  switch (op.kind) {
    case "file.create":
      return applyFileCreate(op, db);
    case "file.update":
      return applyFileUpdate(op, db);
    case "file.delete":
      return applyFileDelete(op, db);
    case "file.move":
      return applyFileMove(op, db);
    case "folder.create":
      return applyFolderCreate(op, db);
    case "folder.delete":
      return applyFolderDelete(op, db);
    case "tag.add":
      return applyTagAdd(op, db);
    case "tag.remove":
      return applyTagRemove(op, db);
    case "favorite.set":
      return applyFavoriteSet(op, db);
    case "project.register":
      return applyProjectRegister(op, db);
    case "project.unregister":
      return applyProjectUnregister(op, db);
    case "calendar.entity.upsert":
      return applyCalendarEntityUpsert(op, db);
    case "calendar.event.upsert":
      return applyCalendarEventUpsert(op, db);
    case "calendar.link.upsert":
      return applyCalendarLinkUpsert(op, db);
    case "journal.meta.upsert":
      return applyJournalMetaUpsert(op, db);
    default: {
      const exhaustiveCheck: never = op.kind;
      throw new Error(`applyRemoteOp: unhandled kind "${exhaustiveCheck}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// File Op Handlers
// ---------------------------------------------------------------------------

async function applyFileCreate(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    path?: string;
    title?: string;
    project_id?: number | null;
    storage_type?: string;
    content_class?: string | null;
    source_path?: string | null;
    content?: string;
    content_hash?: string;
    tags?: string[];
  };

  const filePath = payload.path;
  if (typeof filePath !== "string" || !filePath) {
    throw new Error(`applyRemoteOp: file.create missing path in payload for gid ${op.gid}`);
  }
  const content = typeof payload.content === "string" ? payload.content : "";
  const contentHash = payload.content_hash ?? computeHash(content);
  const title = payload.title ?? basename(filePath);
  const storageType =
    payload.storage_type === "reference" || payload.storage_type === "backup"
      ? payload.storage_type
      : "local";
  const contentClass = payload.content_class ?? null;

  await withLock(fileLockKey(filePath), async () => {
    let fileId: number;
    db.transaction(() => {
      const existing = db
        .prepare("SELECT id, path FROM files WHERE gid = ? OR path = ?")
        .get(op.gid, filePath) as { id: number; path: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE files SET
            path = ?,
            title = ?,
            project_id = ?,
            storage_type = ?,
            content_class = ?,
            source_path = ?,
            content_hash = ?,
            gid = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          filePath,
          title,
          payload.project_id ?? null,
          storageType,
          contentClass,
          payload.source_path ?? null,
          contentHash,
          op.gid,
          existing.id,
        );
        fileId = existing.id;
      } else {
        const result = db.prepare(`
          INSERT INTO files (path, title, project_id, storage_type, content_class, source_path, content_hash, gid)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          filePath,
          title,
          payload.project_id ?? null,
          storageType,
          contentClass,
          payload.source_path ?? null,
          contentHash,
          op.gid,
        );
        fileId = Number(result.lastInsertRowid);
      }

      db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(fileId);
      db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(
        fileId,
        title,
        content,
      );

      if (Array.isArray(payload.tags) && payload.tags.length > 0) {
        for (const tagName of payload.tags) {
          db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tagName);
          const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName) as
            | { id: number }
            | undefined;
          if (tag) {
            db.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)").run(
              fileId,
              tag.id,
            );
          }
        }
      }
    }).immediate();

    // Write to disk after DB update (spec 1.4: watcher hash gating)
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  });
}

async function applyFileUpdate(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    path?: string;
    title?: string;
    content?: string;
    content_hash?: string;
  };

  const existing = db
    .prepare("SELECT id, path, title FROM files WHERE gid = ? OR (path = ? AND ? IS NOT NULL)")
    .get(op.gid, payload.path ?? null, payload.path ?? null) as
    | { id: number; path: string; title: string }
    | undefined;

  const targetPath = payload.path ?? existing?.path;
  if (!targetPath) {
    throw new Error(
      `applyRemoteOp: cannot apply file.update without path or existing file for gid ${op.gid}`,
    );
  }

  const content = typeof payload.content === "string" ? payload.content : "";
  const contentHash = payload.content_hash ?? computeHash(content);
  const title = payload.title ?? existing?.title ?? basename(targetPath);

  await withLock(fileLockKey(targetPath), async () => {
    let fileId: number;
    db.transaction(() => {
      const current = db
        .prepare("SELECT id, path, title FROM files WHERE gid = ? OR (path = ? AND ? IS NOT NULL)")
        .get(op.gid, targetPath, targetPath) as
        | { id: number; path: string; title: string }
        | undefined;
      const fileRecord = current ?? existing;
      if (fileRecord) {
        db.prepare(`
          UPDATE files SET
            path = ?,
            title = ?,
            content_hash = ?,
            gid = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(targetPath, title, contentHash, op.gid, fileRecord.id);
        fileId = fileRecord.id;
      } else {
        const result = db.prepare(`
          INSERT INTO files (path, title, project_id, storage_type, content_class, source_path, content_hash, gid)
          VALUES (?, ?, NULL, 'local', NULL, NULL, ?, ?)
        `).run(targetPath, title, contentHash, op.gid);
        fileId = Number(result.lastInsertRowid);
      }

      db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(fileId);
      db.prepare("INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)").run(
        fileId,
        title,
        content,
      );
    }).immediate();

    // Write to disk after DB update
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, "utf8");
  });
}

async function applyFileDelete(op: Op, db: Database): Promise<void> {
  const payload = op.payload as { path?: string };
  const existing = db
    .prepare("SELECT id, path FROM files WHERE gid = ? OR (path = ? AND ? IS NOT NULL)")
    .get(op.gid, payload.path ?? null, payload.path ?? null) as
    | { id: number; path: string }
    | undefined;

  const targetPath = payload.path ?? existing?.path;
  if (existing) {
    await withLock(fileLockKey(existing.path), async () => {
      db.transaction(() => {
        db.prepare("DELETE FROM files WHERE id = ?").run(existing.id);
        db.prepare("DELETE FROM fts_index WHERE rowid = ?").run(existing.id);
      }).immediate();
      if (existsSync(existing.path)) {
        try {
          rmSync(existing.path, { force: true });
        } catch {}
      }
    });
  } else if (targetPath && existsSync(targetPath)) {
    try {
      rmSync(targetPath, { force: true });
    } catch {}
  }
}

async function applyFileMove(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    from?: string;
    to?: string;
    content_class?: string | null;
  };
  if (!payload.from || !payload.to) {
    throw new Error(`applyRemoteOp: file.move requires 'from' and 'to' paths for gid ${op.gid}`);
  }
  const fromPath = payload.from;
  const toPath = payload.to;

  const existing = db
    .prepare("SELECT id, path FROM files WHERE gid = ? OR path = ?")
    .get(op.gid, fromPath) as { id: number; path: string } | undefined;

  await withLock(fileLockKey(fromPath), async () => {
    await withLock(fileLockKey(toPath), async () => {
      if (existing) {
        db.prepare(`
          UPDATE files SET
            path = ?,
            content_class = COALESCE(?, content_class),
            gid = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(toPath, payload.content_class ?? null, op.gid, existing.id);
      }

      if (existsSync(fromPath)) {
        mkdirSync(dirname(toPath), { recursive: true });
        renameSync(fromPath, toPath);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Folder Op Handlers
// ---------------------------------------------------------------------------

async function applyFolderCreate(op: Op, _db: Database): Promise<void> {
  const payload = op.payload as {
    path?: string;
    project_path?: string;
    folder_name?: string;
  };
  if (payload.path) {
    mkdirSync(payload.path, { recursive: true });
  } else if (payload.project_path && payload.folder_name) {
    createFolder(payload.project_path, payload.folder_name);
  }
}

async function applyFolderDelete(op: Op, _db: Database): Promise<void> {
  const payload = op.payload as {
    path?: string;
    project_path?: string;
    folder_name?: string;
  };
  if (payload.path) {
    if (existsSync(payload.path)) {
      rmSync(payload.path, { recursive: true, force: true });
    }
  } else if (payload.project_path && payload.folder_name) {
    deleteFolder(payload.project_path, payload.folder_name);
  }
}

// ---------------------------------------------------------------------------
// Metadata Op Handlers (Tags, Favorites, Projects)
// ---------------------------------------------------------------------------

async function applyTagAdd(op: Op, db: Database): Promise<void> {
  const payload = op.payload as { file_id?: number; tags?: string[] };
  const file = db
    .prepare("SELECT id FROM files WHERE gid = ?")
    .get(op.gid) as { id: number } | undefined;
  const fileId = file?.id ?? payload.file_id;
  if (fileId !== undefined && Array.isArray(payload.tags) && payload.tags.length > 0) {
    addTags(fileId, payload.tags);
  }
}

async function applyTagRemove(op: Op, db: Database): Promise<void> {
  const payload = op.payload as { file_id?: number; tags?: string[] };
  const file = db
    .prepare("SELECT id FROM files WHERE gid = ?")
    .get(op.gid) as { id: number } | undefined;
  const fileId = file?.id ?? payload.file_id;
  if (fileId !== undefined && Array.isArray(payload.tags) && payload.tags.length > 0) {
    const ph = payload.tags.map(() => "?").join(", ");
    const tagRows = db
      .prepare(`SELECT id FROM tags WHERE name IN (${ph})`)
      .all(...payload.tags) as { id: number }[];
    if (tagRows.length > 0) {
      removeTags(
        fileId,
        tagRows.map((r) => r.id),
      );
    }
  }
}

async function applyFavoriteSet(op: Op, db: Database): Promise<void> {
  const payload = op.payload as { file_id?: number; favorite?: boolean };
  const file = db
    .prepare("SELECT id FROM files WHERE gid = ?")
    .get(op.gid) as { id: number } | undefined;
  const fileId = file?.id ?? payload.file_id;
  if (fileId !== undefined && typeof payload.favorite === "boolean") {
    setFavorite(fileId, payload.favorite);
  }
}

async function applyProjectRegister(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    name?: string;
    slug?: string;
    path?: string;
    description?: string | null;
    remote_url?: string | null;
  };
  if (!payload.name || !payload.slug || !payload.path) {
    throw new Error(
      `applyRemoteOp: project.register requires name, slug, and path for gid ${op.gid}`,
    );
  }

  const byGid = db
    .prepare("SELECT id FROM projects WHERE gid = ?")
    .get(op.gid) as { id: number } | undefined;

  if (byGid) {
    db.prepare(`
      UPDATE projects SET
        name = ?,
        slug = ?,
        path = COALESCE(?, path),
        description = COALESCE(?, description),
        remote_url = COALESCE(?, remote_url)
      WHERE id = ?
    `).run(
      payload.name,
      payload.slug,
      payload.path,
      payload.description ?? null,
      payload.remote_url ?? null,
      byGid.id,
    );
  } else {
    const byNameOrSlug = db
      .prepare("SELECT id FROM projects WHERE name = ? OR slug = ?")
      .get(payload.name, payload.slug) as { id: number } | undefined;

    if (byNameOrSlug) {
      db.prepare(`
        UPDATE projects SET
          gid = ?,
          description = COALESCE(?, description),
          remote_url = COALESCE(?, remote_url)
        WHERE id = ?
      `).run(
        op.gid,
        payload.description ?? null,
        payload.remote_url ?? null,
        byNameOrSlug.id,
      );
    } else {
      db.prepare(`
        INSERT INTO projects (name, slug, path, description, remote_url, gid)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        payload.name,
        payload.slug,
        payload.path,
        payload.description ?? null,
        payload.remote_url ?? null,
        op.gid,
      );
    }
  }
}

async function applyProjectUnregister(op: Op, db: Database): Promise<void> {
  const payload = op.payload as { project_id?: number; slug?: string | null };
  const project = db
    .prepare("SELECT id FROM projects WHERE gid = ? OR (slug = ? AND ? IS NOT NULL)")
    .get(op.gid, payload.slug ?? null, payload.slug ?? null) as
    | { id: number }
    | undefined;

  const projectId = project?.id ?? payload.project_id;
  if (projectId) {
    const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (existing) {
      unregisterProject(projectId);
    }
  }
}

// ---------------------------------------------------------------------------
// Calendar Op Handlers
// ---------------------------------------------------------------------------

async function applyCalendarEntityUpsert(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    name: string;
    kind?: string | null;
    notes?: string | null;
    timezone?: string | null;
    active?: boolean;
    deleted?: boolean;
  };

  const existing = db
    .prepare("SELECT id FROM calendar_entities WHERE gid = ?")
    .get(op.gid) as { id: number } | undefined;

  if (payload.deleted) {
    if (existing) {
      deleteEntity(existing.id);
    }
  } else {
    if (existing) {
      updateEntity(existing.id, {
        name: payload.name,
        kind: payload.kind ?? undefined,
        notes: payload.notes ?? undefined,
        timezone: payload.timezone ?? undefined,
        active: payload.active,
      });
    } else {
      const created = createEntity({
        name: payload.name,
        kind: payload.kind ?? undefined,
        notes: payload.notes ?? undefined,
        timezone: payload.timezone ?? undefined,
        active: payload.active,
      });
      db.prepare("UPDATE calendar_entities SET gid = ? WHERE id = ?").run(op.gid, created.id);
    }
  }
}

async function applyCalendarEventUpsert(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    entity_id: number;
    type: string;
    title: string;
    notes?: string | null;
    starts_at: string;
    ends_at: string;
    original_timezone?: string | null;
    source?: string | null;
    deleted?: boolean;
  };

  const existing = db
    .prepare("SELECT id FROM calendar_events WHERE gid = ?")
    .get(op.gid) as { id: number } | undefined;

  if (payload.deleted) {
    if (existing) {
      deleteEvent(existing.id);
    }
  } else {
    if (existing) {
      updateEvent(existing.id, {
        entity_id: payload.entity_id,
        type: payload.type,
        title: payload.title,
        notes: payload.notes,
        starts_at: payload.starts_at,
        ends_at: payload.ends_at,
        original_timezone: payload.original_timezone,
        source: payload.source,
      });
    } else {
      const entity = db
        .prepare("SELECT id FROM calendar_entities WHERE id = ?")
        .get(payload.entity_id);
      if (entity) {
        const created = createEvent({
          entity_id: payload.entity_id,
          type: payload.type,
          title: payload.title,
          notes: payload.notes,
          starts_at: payload.starts_at,
          ends_at: payload.ends_at,
          original_timezone: payload.original_timezone,
          source: payload.source,
        });
        db.prepare("UPDATE calendar_events SET gid = ? WHERE id = ?").run(op.gid, created.id);
      }
    }
  }
}

async function applyCalendarLinkUpsert(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    from_entity_id: number;
    to_entity_id: number;
    label?: string | null;
    deleted?: boolean;
  };

  if (payload.deleted) {
    unlinkEntities(payload.from_entity_id, payload.to_entity_id);
  } else {
    const fromExists = db
      .prepare("SELECT 1 FROM calendar_entities WHERE id = ?")
      .get(payload.from_entity_id);
    const toExists = db
      .prepare("SELECT 1 FROM calendar_entities WHERE id = ?")
      .get(payload.to_entity_id);
    if (fromExists && toExists) {
      linkEntities(payload.from_entity_id, payload.to_entity_id, payload.label ?? undefined);
      db.prepare(
        "UPDATE calendar_links SET gid = ? WHERE from_entity_id = ? AND to_entity_id = ?",
      ).run(op.gid, payload.from_entity_id, payload.to_entity_id);
    }
  }
}

// ---------------------------------------------------------------------------
// Journal Op Handlers
// ---------------------------------------------------------------------------

async function applyJournalMetaUpsert(op: Op, db: Database): Promise<void> {
  const payload = op.payload as {
    file_id: number;
    project_id?: number | null;
    task_slug: string;
    status_latest?: string | null;
    started_at?: string | null;
    last_active_at?: string | null;
    touched_files?: string[];
    raw_sources?: string[];
    git_refs?: Array<{ ref_type: "branch" | "commit" | "ticket"; ref_value: string }>;
  };

  const file = db
    .prepare("SELECT id, project_id FROM files WHERE gid = ? OR id = ?")
    .get(op.gid, payload.file_id) as { id: number; project_id: number | null } | undefined;
  const targetFileId = file ? file.id : payload.file_id;

  const fileExists = db.prepare("SELECT 1 FROM files WHERE id = ?").get(targetFileId);
  if (fileExists) {
    let projectId = payload.project_id ?? file?.project_id ?? undefined;
    if (projectId !== undefined) {
      const proj = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
      if (!proj) projectId = undefined;
    }
    if (!projectId && file?.project_id) {
      const proj = db.prepare("SELECT 1 FROM projects WHERE id = ?").get(file.project_id);
      if (proj) projectId = file.project_id;
    }
    if (!projectId) {
      const anyProj = db.prepare("SELECT id FROM projects LIMIT 1").get() as
        | { id: number }
        | undefined;
      if (anyProj) {
        projectId = anyProj.id;
      } else {
        db.prepare(
          "INSERT OR IGNORE INTO projects (name, slug, path) VALUES ('Default Project', 'default', NULL)",
        ).run();
        const p = db.prepare("SELECT id FROM projects WHERE slug = 'default'").get() as {
          id: number;
        };
        projectId = p.id;
      }
    }

    const nowIso = new Date().toISOString();
    const startedAt = payload.started_at ?? nowIso;
    const lastActiveAt = payload.last_active_at ?? nowIso;

    upsertJournalMeta({
      file_id: targetFileId,
      project_id: projectId,
      task_slug: payload.task_slug,
      status_latest: (payload.status_latest as any) ?? null,
      started_at: startedAt,
      last_active_at: lastActiveAt,
      touched_files: payload.touched_files ?? [],
      raw_sources: payload.raw_sources ?? [],
      git_refs: (payload.git_refs as any) ?? [],
    });
    db.prepare("UPDATE journal_meta SET gid = ? WHERE file_id = ?").run(op.gid, targetFileId);
  }
}
