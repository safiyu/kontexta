// packages/core/src/journal/engine.ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../db/index.js";
import { distillJournal } from "./distill.js";

const REL_BASE = ["knowledge", "journal"];

// Must match the inFlightWindowSeconds passed to distillJournal in
// startDistillEngine's tick below. Without this buffer, an event that
// arrives during a distill run (and is deferred by distillJournal's own
// in-flight window) can be missed forever: the just-finished run's
// high-water file write gets a disk mtime AFTER the deferred event's
// raw-file mtime, so a naive `raw > hw` comparison falsely reports the
// slug as clean on every later tick, even though the deferred event was
// never processed. Subtracting this buffer keeps the slug "dirty" until
// enough real time has passed that distillJournal's own in-flight window
// would also have cleared.
const IN_FLIGHT_BUFFER_MS = 300_000;

/**
 * Enumerate journal slugs that have raw events not yet reflected in their
 * high-water mark. Uses file mtimes only (no JSONL parsing) so it's cheap
 * to call every tick. Over-reporting is fine — distillJournal is idempotent
 * and returns events_processed: 0 for a slug with nothing new. Returned in
 * newest-raw-mtime-descending order so recent work distills first.
 */
export function listSlugsWithBacklog(dataDir: string): string[] {
  const journalRoot = join(dataDir, ...REL_BASE);
  if (!existsSync(journalRoot)) return [];

  const dirty: Array<{ slug: string; newestMtime: number }> = [];

  for (const entry of readdirSync(journalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const rawDir = join(journalRoot, slug, "raw");
    if (!existsSync(rawDir)) continue;

    const hwPath = join(journalRoot, slug, ".distilled-up-to.json");
    const hwMtime = existsSync(hwPath) ? statSync(hwPath).mtimeMs : null;
    const dirtyCutoff = hwMtime === null ? null : hwMtime - IN_FLIGHT_BUFFER_MS;

    let newestRawMtime = 0;
    let isDirty = hwMtime === null;
    for (const file of readdirSync(rawDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const mtime = statSync(join(rawDir, file)).mtimeMs;
      if (mtime > newestRawMtime) newestRawMtime = mtime;
      if (dirtyCutoff !== null && mtime > dirtyCutoff) isDirty = true;
    }
    if (newestRawMtime === 0) continue; // no raw events at all
    if (isDirty) dirty.push({ slug, newestMtime: newestRawMtime });
  }

  return dirty.sort((a, b) => b.newestMtime - a.newestMtime).map((d) => d.slug);
}

function deriveProjectName(slug: string): string {
  if (slug === "default") return "Default (unregistered work)";
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Return the project id for `slug`, auto-provisioning a synthetic row
 * (path: NULL) if none exists yet. Synthetic rows are how orphan journal
 * slugs (unregistered directories) become distillable without requiring
 * `register_project` first. Safe under concurrent callers, including
 * across processes — the insert is re-checked inside a transaction, and a
 * losing UNIQUE-constraint insert falls back to re-reading the winner's row.
 */
export function ensureProjectRowForSlug(slug: string): number {
  const db = getDatabase();

  const existing = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (existing) return existing.id;

  const baseName = deriveProjectName(slug);
  const description = `Auto-provisioned by distillation engine for orphan slug '${slug}'.`;

  const txn = db.transaction((): number => {
    const recheck = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: number } | undefined;
    if (recheck) return recheck.id;

    let name = baseName;
    let suffix = 0;
    for (;;) {
      const nameTaken = db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name);
      if (!nameTaken) break;
      suffix += 1;
      name = suffix === 1 ? `${baseName} (auto)` : `${baseName} (auto ${suffix})`;
    }

    try {
      const result = db
        .prepare(`INSERT INTO projects (name, slug, description, path) VALUES (?, ?, ?, NULL)`)
        .run(name, slug, description);
      return Number(result.lastInsertRowid);
    } catch (err: any) {
      if (String(err?.code) === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/.test(String(err?.message))) {
        const winner = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: number } | undefined;
        if (winner) return winner.id;
      }
      throw err;
    }
  });

  return txn();
}

export interface StartEngineOpts {
  dataDir: string;
  tickMs?: number;
  drainOnStart?: boolean;
  maxEventsPerSlug?: number;
  onError?: (err: unknown, slug: string) => void;
  now?: () => Date;
}

export interface TickResult {
  slugs_considered: number;
  slugs_distilled: number;
  slugs_skipped_clean: number;
  slugs_failed: number;
  duration_ms: number;
}

export interface EngineHandle {
  stop(opts?: { flush?: boolean }): Promise<void>;
  tickNow(): Promise<TickResult>;
}

/**
 * Start the background distillation engine: drains any existing backlog
 * (if drainOnStart), then ticks every tickMs, distilling every slug with
 * pending raw events regardless of whether it's a registered project.
 */
export function startDistillEngine(opts: StartEngineOpts): EngineHandle {
  const dataDir = opts.dataDir;
  const tickMs = opts.tickMs ?? 5 * 60_000;
  const drainOnStart = opts.drainOnStart ?? true;
  const maxEventsPerSlug = opts.maxEventsPerSlug ?? 500;
  const onError = opts.onError ?? ((err: unknown, slug: string) => console.warn(`[distill-engine] slug=${slug}`, err));
  const now = opts.now ?? (() => new Date());

  let running: Promise<TickResult> | null = null;
  let stopped = false;

  async function runTick(): Promise<TickResult> {
    const start = Date.now();
    const result: TickResult = {
      slugs_considered: 0,
      slugs_distilled: 0,
      slugs_skipped_clean: 0,
      slugs_failed: 0,
      duration_ms: 0,
    };
    try {
      const dirtySlugs = listSlugsWithBacklog(dataDir);
      result.slugs_considered = dirtySlugs.length;
      for (const slug of dirtySlugs) {
        try {
          const projectId = ensureProjectRowForSlug(slug);
          const distillResult = await distillJournal({
            projectSlug: slug,
            projectId,
            dataDir,
            maxEvents: maxEventsPerSlug,
            ticketRegex: /[A-Z]+-\d+/,
            openTaskWindowDays: 90,
            inFlightWindowSeconds: IN_FLIGHT_BUFFER_MS / 1000,
            now: now(),
          });
          if (distillResult.events_processed > 0) {
            result.slugs_distilled++;
          } else {
            result.slugs_skipped_clean++;
          }
        } catch (err) {
          result.slugs_failed++;
          onError(err, slug);
        }
      }
    } catch (err) {
      onError(err, "*enumeration*");
    }
    result.duration_ms = Date.now() - start;
    return result;
  }

  function tickNow(): Promise<TickResult> {
    if (running) return running;
    const p = runTick().finally(() => { running = null; });
    running = p;
    return p;
  }

  let timer: NodeJS.Timeout | null = setInterval(() => { void tickNow(); }, tickMs);
  timer.unref();

  if (drainOnStart) {
    setImmediate(() => { void tickNow(); });
  }

  return {
    tickNow,
    async stop(stopOpts?: { flush?: boolean }): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (stopOpts?.flush) {
        await tickNow();
      }
    },
  };
}
