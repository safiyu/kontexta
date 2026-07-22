# Journal Distillation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make journal distillation run reliably for every project slug that receives raw events — including unregistered directories (home directory, ad-hoc scripts, random repos) — by adding an in-process background engine and auto-provisioning synthetic project rows for orphan slugs.

**Architecture:** A new `packages/core/src/journal/engine.ts` module exposes `listSlugsWithBacklog`, `ensureProjectRowForSlug`, and `startDistillEngine`. MCP starts the engine at boot and flushes it on shutdown. The existing `distill_journal` tool and the envelope-suggestion nudge are updated to match the engine's new orphan-slug-friendly behavior.

**Tech Stack:** TypeScript, better-sqlite3, Node.js `fs`/`timers`. Tests: `vitest` for `packages/core` (runs against TS source directly), `node:test` for `apps/mcp` (runs against built `dist/` — requires `pnpm build` first).

## Global Constraints

- No schema migration — `journal_meta.project_id` stays `NOT NULL`; `projects.path` is already nullable and is the synthetic-row marker.
- No external process — no launchd, cron, or CLI daemon. The engine is in-process only, exported from `kxta-core` so a future CLI wrapper is trivial but out of scope here.
- The `default` slug remains the single shared bucket for all unregistered cwds — no per-cwd sharding.
- Engine defaults: tick every 5 minutes, drain on start, flush (with a 10s cap) on graceful shutdown.
- All engine configuration is via env vars, read once at start (no hot reload): `KONTEXTA_DISTILL_ENGINE` (default `"on"`), `KONTEXTA_DISTILL_TICK_MS` (default `300000`), `KONTEXTA_DISTILL_DRAIN_ON_START` (default `"true"`), `KONTEXTA_DISTILL_MAX_EVENTS` (default `500`).
- Cross-process concurrency relies entirely on the existing `acquireCooldown`/`releaseCooldown` SQLite lock in `packages/core/src/journal/cooldown.ts` — no new locking primitive.
- The envelope-suggestion nudge threshold changes from `backlog_events >= 1` to `backlog_events >= 50 OR backlog_oldest_age_hours >= 1`.
- `packages/core` tests: `pnpm --filter kxta-core exec vitest run <path>` (runs against `src/`, no build needed). `apps/mcp` tests: build first (`pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build`), then `node --test apps/mcp/tests/<file>.test.mjs` (runs against `dist/`).

---

### Task 1: `listSlugsWithBacklog` — cheap mtime-based backlog probe

**Files:**
- Create: `packages/core/src/journal/engine.ts`
- Test: `packages/core/tests/journal/engine.test.ts`

**Interfaces:**
- Consumes: nothing new (only `node:fs`).
- Produces: `listSlugsWithBacklog(dataDir: string): string[]` — used by Task 4's `startDistillEngine`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/journal/engine.test.ts`:

```ts
// packages/core/tests/journal/engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSlugsWithBacklog } from "../../src/journal/engine.js";

describe("listSlugsWithBacklog", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function journalRoot() {
    return join(testDir, "knowledge", "journal");
  }

  function writeRaw(slug: string, file: string, mtime: Date) {
    const dir = join(journalRoot(), slug, "raw");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, file);
    writeFileSync(p, JSON.stringify({ ts: mtime.toISOString(), agent: "x", sid: "x", event: "tool_call" }) + "\n");
    utimesSync(p, mtime, mtime);
  }

  function writeHighWater(slug: string, mtime: Date) {
    const p = join(journalRoot(), slug, ".distilled-up-to.json");
    writeFileSync(p, JSON.stringify({ last_event_ts: mtime.toISOString(), last_distilled_at: mtime.toISOString(), events_processed: 1 }));
    utimesSync(p, mtime, mtime);
  }

  it("returns [] when the journal root does not exist", () => {
    expect(listSlugsWithBacklog(testDir)).toEqual([]);
  });

  it("returns a slug with raw events and no high-water file", () => {
    writeRaw("default", "2026-07-22.jsonl", new Date("2026-07-22T10:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual(["default"]);
  });

  it("skips a slug whose high-water file is newer than all raw files", () => {
    writeRaw("clean-slug", "2026-07-22.jsonl", new Date("2026-07-22T10:00:00Z"));
    writeHighWater("clean-slug", new Date("2026-07-22T11:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual([]);
  });

  it("includes a slug whose raw file is newer than its high-water file", () => {
    writeHighWater("stale-slug", new Date("2026-07-22T09:00:00Z"));
    writeRaw("stale-slug", "2026-07-22.jsonl", new Date("2026-07-22T10:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual(["stale-slug"]);
  });

  it("skips a slug with a raw/ dir but no .jsonl files", () => {
    mkdirSync(join(journalRoot(), "empty-slug", "raw"), { recursive: true });
    expect(listSlugsWithBacklog(testDir)).toEqual([]);
  });

  it("sorts dirty slugs by newest raw mtime, descending", () => {
    writeRaw("older", "a.jsonl", new Date("2026-07-20T10:00:00Z"));
    writeRaw("newer", "a.jsonl", new Date("2026-07-22T10:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual(["newer", "older"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run tests/journal/engine.test.ts`
Expected: FAIL — `Cannot find module '../../src/journal/engine.js'` (or similar resolution error), since the file doesn't exist yet.

- [ ] **Step 3: Implement `listSlugsWithBacklog`**

Create `packages/core/src/journal/engine.ts`:

```ts
// packages/core/src/journal/engine.ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const REL_BASE = ["knowledge", "journal"];

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

    let newestRawMtime = 0;
    let isDirty = hwMtime === null;
    for (const file of readdirSync(rawDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const mtime = statSync(join(rawDir, file)).mtimeMs;
      if (mtime > newestRawMtime) newestRawMtime = mtime;
      if (hwMtime !== null && mtime > hwMtime) isDirty = true;
    }
    if (newestRawMtime === 0) continue; // no raw events at all
    if (isDirty) dirty.push({ slug, newestMtime: newestRawMtime });
  }

  return dirty.sort((a, b) => b.newestMtime - a.newestMtime).map((d) => d.slug);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run tests/journal/engine.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/journal/engine.ts packages/core/tests/journal/engine.test.ts
git commit -m "feat(journal): add listSlugsWithBacklog for orphan-slug distillation"
```

---

### Task 2: `ensureProjectRowForSlug` — synthetic project provisioning

**Files:**
- Modify: `packages/core/src/journal/engine.ts`
- Modify: `packages/core/tests/journal/engine.test.ts`

**Interfaces:**
- Consumes: `getDatabase()` from `../db/index.js`.
- Produces: `ensureProjectRowForSlug(slug: string): number` — used by `distill_journal` tool (Task 5) and `startDistillEngine` (Task 4).

- [ ] **Step 1: Write the failing test**

Add to the top of `packages/core/tests/journal/engine.test.ts` (alongside the existing imports):

```ts
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { listSlugsWithBacklog, ensureProjectRowForSlug } from "../../src/journal/engine.js";
```

(This replaces the existing `import { listSlugsWithBacklog } from "../../src/journal/engine.js";` line — the DB imports are new.)

Append a new `describe` block to the end of the file:

```ts
describe("ensureProjectRowForSlug", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-provision-test-"));
    createDatabase(join(testDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a synthetic project row with path NULL for an unknown slug", () => {
    const id = ensureProjectRowForSlug("default");
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    expect(row.slug).toBe("default");
    expect(row.path).toBeNull();
    expect(row.name).toBe("Default (unregistered work)");
    expect(row.description).toMatch(/orphan slug 'default'/);
  });

  it("derives a titlecased name for non-default slugs", () => {
    const id = ensureProjectRowForSlug("scratch-notes");
    const db = getDatabase();
    const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as any;
    expect(row.name).toBe("Scratch Notes");
  });

  it("is idempotent — calling twice returns the same id", () => {
    const first = ensureProjectRowForSlug("default");
    const second = ensureProjectRowForSlug("default");
    expect(second).toBe(first);
    const db = getDatabase();
    const count = db.prepare("SELECT COUNT(*) AS c FROM projects WHERE slug = ?").get("default") as any;
    expect(count.c).toBe(1);
  });

  it("suffixes the name when it collides with an existing registered project", () => {
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (name, slug, path) VALUES (?, ?, ?)`).run("Scratch", "some-other-slug", "/tmp/scratch");
    const id = ensureProjectRowForSlug("scratch");
    const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as any;
    expect(row.name).toBe("Scratch (auto)");
  });

  it("returns the existing id when a project is already registered for that slug", () => {
    const db = getDatabase();
    const result = db.prepare(`INSERT INTO projects (name, slug, path) VALUES (?, ?, ?)`).run("Demo", "demo", "/tmp/demo");
    const existingId = Number(result.lastInsertRowid);
    const id = ensureProjectRowForSlug("demo");
    expect(id).toBe(existingId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run tests/journal/engine.test.ts`
Expected: FAIL — `ensureProjectRowForSlug` is not exported from `../../src/journal/engine.js`.

- [ ] **Step 3: Implement `ensureProjectRowForSlug`**

Add to `packages/core/src/journal/engine.ts` — change the import line at the top:

```ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../db/index.js";
```

Then append to the end of the file:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run tests/journal/engine.test.ts`
Expected: PASS — all 11 tests green (6 from Task 1 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/journal/engine.ts packages/core/tests/journal/engine.test.ts
git commit -m "feat(journal): add ensureProjectRowForSlug for synthetic project provisioning"
```

---

### Task 3: `register_project` upsert-on-synthetic

**Files:**
- Modify: `packages/core/src/metadata/index.ts:195-248` (`registerProject`)
- Modify: `packages/core/tests/metadata.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `registerProject(...)` now returns `ProjectRecord & { newlyIndexed: number; promotion_warning?: string }` — the added optional field is consumed by Task 7's MCP `register_project` tool wrapper (surfaced in its `warnings` array), but that's an existing call site, not a new dependency.

- [ ] **Step 1: Write the failing tests**

In `packages/core/tests/metadata.test.ts`, add these three tests immediately after the existing `it("registerProject: creates project with correct slug", ...)` block (around line 203):

```ts
  it("registerProject: promotes a synthetic (path=NULL) project in place", () => {
    const db = getDatabase();
    const result = db.prepare(
      `INSERT INTO projects (name, slug, description, path) VALUES (?, ?, ?, NULL)`
    ).run("Default (unregistered work)", "default", "Auto-provisioned by distillation engine for orphan slug 'default'.");
    const syntheticId = Number(result.lastInsertRowid);

    const project = registerProject("Default", "/home/user/projects/default", "My real project");

    expect(project.id).toBe(syntheticId);
    expect(project.path).toBe("/home/user/projects/default");
    expect(project.name).toBe("Default");
    expect(project.description).toBe("My real project");
    expect(project.promotion_warning).toBeUndefined();
  });

  it("registerProject: promotes a synthetic project found via its own generated name", () => {
    // Distinct from the previous test: here `existing` is resolved via the
    // byName lookup (the caller's name argument exactly matches the
    // synthetic row's auto-generated name), not via the bySlug fallback.
    const db = getDatabase();
    const result = db.prepare(
      `INSERT INTO projects (name, slug, description, path) VALUES (?, ?, ?, NULL)`
    ).run("Scratch (auto)", "scratch", "Auto-provisioned by distillation engine for orphan slug 'scratch'.");
    const syntheticId = Number(result.lastInsertRowid);

    const project = registerProject("Scratch (auto)", "/home/user/projects/scratch", "My real scratch project");

    expect(project.id).toBe(syntheticId);
    expect(project.path).toBe("/home/user/projects/scratch");
    expect(project.name).toBe("Scratch (auto)");
    expect(project.description).toBe("My real scratch project");
    expect(project.promotion_warning).toBeUndefined();
  });

  it("registerProject: still throws PROJECT_CONFLICT for a real (non-null path) conflict", () => {
    registerProject("Existing Real Project", "/tmp/existing-real");
    expect(() => registerProject("Existing Real Project", "/tmp/different-path")).toThrow(/Cannot register/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/metadata.test.ts`
Expected: FAIL — the first two new tests fail because `registerProject` currently throws `PROJECT_CONFLICT` for a synthetic row instead of promoting it (`existing.path !== absolutePath` is true when `existing.path` is `null`).

- [ ] **Step 3: Implement the upsert-on-synthetic branch**

Replace the `registerProject` function body in `packages/core/src/metadata/index.ts` (lines 195-248) with:

```ts
export function registerProject(
  name: string,
  path: string,
  description?: string,
  remoteUrl?: string
): ProjectRecord & { newlyIndexed: number; promotion_warning?: string } {
  const db = getDatabase();

  const slug = slugify(name);
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO projects (name, slug, path, description, remote_url)
    VALUES (?, ?, ?, ?, ?)
  `);

  const absolutePath = resolve(path);
  const result = insertStmt.run(name, slug, absolutePath, description || null, remoteUrl || null);

  let projectId: number;
  let promotionWarning: string | undefined;

  if (result.changes > 0) {
    projectId = Number(result.lastInsertRowid);
  } else {
    // INSERT was ignored — either name OR slug already exists. Look both up so
    // we can give a precise error when the *path* conflicts with the existing
    // row, vs. silently returning a stale record under a different path.
    const byName = db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRecord | undefined;
    const bySlug = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRecord | undefined;
    const existing = byName ?? bySlug;
    if (!existing) {
      // Should be unreachable: INSERT was ignored but neither name nor slug matches.
      throw new Error(`registerProject: insert ignored but no matching project found for name='${name}'`);
    }
    if (existing.path === null) {
      // Synthetic project (auto-provisioned by the journal distillation
      // engine for an orphan slug) — promote it in place instead of
      // throwing, so journal entries already keyed to this project_id
      // stay linked to the same row.
      try {
        db.prepare(
          `UPDATE projects SET name = ?, path = ?, description = ?, remote_url = ? WHERE id = ?`
        ).run(name, absolutePath, description || null, remoteUrl || null, existing.id);
      } catch (err: any) {
        if (!/UNIQUE constraint failed: projects\.name/.test(String(err?.message))) throw err;
        // The requested name collides with a different project — keep the
        // synthetic name, still promote path/description/remote_url.
        db.prepare(
          `UPDATE projects SET path = ?, description = ?, remote_url = ? WHERE id = ?`
        ).run(absolutePath, description || null, remoteUrl || null, existing.id);
        promotionWarning = `Project name '${name}' is already taken; kept auto-generated name '${existing.name}' and updated path/description only.`;
      }
      projectId = existing.id;
    } else if (existing.path !== absolutePath) {
      const conflicts: string[] = [];
      if (byName) conflicts.push(`name conflicts with '${byName.name}' at '${byName.path}'`);
      if (bySlug && bySlug.id !== byName?.id) conflicts.push(`slug '${slug}' conflicts with '${bySlug.name}' at '${bySlug.path}'`);
      const err = new Error(
        `Cannot register '${name}' at '${path}': ${conflicts.join("; ")}. ` +
        `Pick a different name or unregister the existing project first.`
      );
      (err as any).code = "PROJECT_CONFLICT";
      throw err;
    } else {
      projectId = existing.id;
    }
  }

  // Auto-discover and index files in the project directory.
  const newlyIndexed = reconcileIndex({ projectId, dataDir: getDataDir() }).newRecords.length;

  return {
    ...(db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRecord),
    newlyIndexed,
    ...(promotionWarning ? { promotion_warning: promotionWarning } : {}),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/metadata.test.ts`
Expected: PASS — all tests in the file green, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metadata/index.ts packages/core/tests/metadata.test.ts
git commit -m "feat(metadata): registerProject promotes synthetic (path=NULL) projects in place"
```

---

### Task 4: `startDistillEngine` — tick logic, lifecycle, barrel export

**Files:**
- Modify: `packages/core/src/journal/engine.ts`
- Modify: `packages/core/src/journal/index.ts`
- Modify: `packages/core/tests/journal/engine.test.ts`

**Interfaces:**
- Consumes: `listSlugsWithBacklog` (Task 1), `ensureProjectRowForSlug` (Task 2), `distillJournal` from `./distill.js`.
- Produces: `startDistillEngine(opts: StartEngineOpts): EngineHandle`, plus types `StartEngineOpts`, `TickResult`, `EngineHandle` — exported from `kxta-core` (via `journal/index.ts` → package root) for Task 5 (MCP wiring) and Task 8 (integration test) to consume.

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `packages/core/tests/journal/engine.test.ts`:

```ts
import { existsSync } from "node:fs";
import { listSlugsWithBacklog, ensureProjectRowForSlug, startDistillEngine } from "../../src/journal/engine.js";
```

(This replaces the existing `import { listSlugsWithBacklog, ensureProjectRowForSlug } from "../../src/journal/engine.js";` line — `existsSync` and `startDistillEngine` are new.)

Append these two `describe` blocks to the end of the file:

```ts
function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() - start > timeoutMs) return rejectPromise(new Error("waitFor: timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("startDistillEngine — tick behavior", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-tick-test-"));
    createDatabase(join(testDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeRawEvent(slug: string, ts: string) {
    const dir = join(testDir, "knowledge", "journal", slug, "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${ts.slice(0, 10)}.jsonl`),
      JSON.stringify({ ts, agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }) + "\n",
    );
  }

  it("distills a dirty slug and provisions a synthetic project", async () => {
    writeRawEvent("default", "2026-07-22T10:00:00Z");

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      const result = await engine.tickNow();
      expect(result.slugs_considered).toBe(1);
      expect(result.slugs_distilled).toBe(1);
      expect(result.slugs_failed).toBe(0);

      const db = getDatabase();
      const project = db.prepare("SELECT * FROM projects WHERE slug = ?").get("default") as any;
      expect(project).toBeDefined();
      expect(project.path).toBeNull();

      const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
      expect(existsSync(distilledRoot)).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("skips a slug with no backlog", async () => {
    const engine = startDistillEngine({ dataDir: testDir, drainOnStart: false });
    try {
      const result = await engine.tickNow();
      expect(result.slugs_considered).toBe(0);
      expect(result.slugs_distilled).toBe(0);
    } finally {
      await engine.stop();
    }
  });

  it("does not let one failing slug block the next", async () => {
    writeRawEvent("default", "2026-07-22T10:00:00Z");
    writeRawEvent("also-dirty", "2026-07-22T10:00:00Z");

    // Force distillJournal to throw for "default" only: pre-create a regular
    // file where it needs to mkdir a YYYY directory, so mkdirSync(recursive)
    // fails with ENOTDIR. "also-dirty" is untouched and should still succeed.
    const sabotagedPath = join(testDir, "knowledge", "journal", "default", "2026");
    writeFileSync(sabotagedPath, "not a directory");

    const errors: Array<{ slug: string }> = [];
    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
      onError: (_err, slug) => errors.push({ slug }),
    });
    try {
      const result = await engine.tickNow();
      expect(result.slugs_considered).toBe(2);
      expect(result.slugs_distilled).toBe(1);
      expect(result.slugs_failed).toBe(1);
      expect(errors.map((e) => e.slug)).toEqual(["default"]);
    } finally {
      await engine.stop();
    }
  });
});

describe("startDistillEngine — lifecycle", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-lifecycle-test-"));
    createDatabase(join(testDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("drains on start when drainOnStart is true (default)", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      tickMs: 60_000,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
      await waitFor(() => existsSync(distilledRoot));
      expect(existsSync(distilledRoot)).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("does not drain on start when drainOnStart is false", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call" }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      tickMs: 60_000,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
      expect(existsSync(distilledRoot)).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("stop({flush:true}) awaits one final tick", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call" }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      tickMs: 60_000,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    await engine.stop({ flush: true });
    const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
    expect(existsSync(distilledRoot)).toBe(true);
  });

  it("stop() is idempotent", async () => {
    const engine = startDistillEngine({ dataDir: testDir, drainOnStart: false, tickMs: 60_000 });
    await engine.stop();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it("tickNow() collapses overlapping calls into one in-flight promise", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call" }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      tickMs: 60_000,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      const [a, b] = await Promise.all([engine.tickNow(), engine.tickNow()]);
      expect(a).toBe(b);
    } finally {
      await engine.stop();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/journal/engine.test.ts`
Expected: FAIL — `startDistillEngine` is not exported from `../../src/journal/engine.js`.

- [ ] **Step 3: Implement `startDistillEngine`**

Append to the end of `packages/core/src/journal/engine.ts` (and add `import { distillJournal } from "./distill.js";` to the top imports):

```ts
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
            inFlightWindowSeconds: 300,
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
```

- [ ] **Step 4: Export from the journal barrel**

Modify `packages/core/src/journal/index.ts` — add this line (anywhere in the file, e.g. at the end):

```ts
export { listSlugsWithBacklog, ensureProjectRowForSlug, startDistillEngine } from "./engine.js";
export type { StartEngineOpts, TickResult, EngineHandle } from "./engine.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/journal/engine.test.ts`
Expected: PASS — all tests green (11 from Tasks 1-2 + 9 new = 20 total).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/journal/engine.ts packages/core/src/journal/index.ts packages/core/tests/journal/engine.test.ts
git commit -m "feat(journal): add startDistillEngine background tick/lifecycle"
```

---

### Task 5: `distill_journal` MCP tool provisions orphan slugs

**Files:**
- Modify: `apps/mcp/src/journal-tools.ts`
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Consumes: `ensureProjectRowForSlug` from `kxta-core` (Task 2).
- Produces: no new exports — this closes the gap where a manual `distill_journal` call on an orphan slug errored with `unknown project_slug`.

- [ ] **Step 1: Write the failing test**

In `apps/mcp/test-tools.mjs`, insert this test block right after the `// 2. Discover tools.` section (after the `console.log("");` on line ~113, before `let seedFile1, seedFile2;`):

```js
  await test("distill_journal on unregistered slug auto-provisions a project", async () => {
    const r = await call("distill_journal", { project_slug: "orphan-smoke-test" });
    assert(typeof r.events_processed === "number", "missing events_processed");
    assert(Array.isArray(r.warnings), "missing warnings array");

    const projects = await call("list_projects", {});
    const provisioned = projects.find((p) => p.slug === "orphan-smoke-test");
    assert(provisioned, "expected an auto-provisioned project for orphan-smoke-test");
    assert(provisioned.path === null, `expected path to be null, got ${provisioned.path}`);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build && node apps/mcp/test-tools.mjs`
Expected: FAIL on the new test — `distill_journal returned isError: {"error":"unknown project_slug: orphan-smoke-test"}`.

- [ ] **Step 3: Implement the fix**

Replace the full contents of `apps/mcp/src/journal-tools.ts` with:

```ts
// apps/mcp/src/journal-tools.ts
import { z } from "zod";
import { distillJournal, ensureProjectRowForSlug, readHighWater, getDataDir } from "kxta-core";
import type { RawEvent } from "kxta-core";
import {
  appendVoluntaryEvent,
  getCurrentProjectSlug,
  getCurrentAgent,
  getCurrentSid,
} from "./journal-capture.js";

export function registerJournalTools(server: any): void {
  server.tool(
    "journal_note",
    "Record a free-form decision/abandonment/observation note in the current project's journal. Stored as an `agent_note` event in Layer 1; surfaces in distilled task entries.",
    {
      text: z.string().min(1).describe("Body of the note (markdown allowed)."),
      tags: z.array(z.string()).optional().describe("Optional tags for the note."),
    },
    async ({ text, tags }: { text: string; tags?: string[] }) => {
      const ev: RawEvent = {
        ts: new Date().toISOString(),
        agent: getCurrentAgent(),
        sid: getCurrentSid(),
        event: "agent_note",
        summary: text,
        tags: tags ?? [],
      };
      appendVoluntaryEvent(ev);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded_at: ev.ts }) }] };
    },
  );

  server.tool(
    "journal_intent",
    "Record a topic/intent pivot. Use when the user redirects what you're working on; the distillation step uses this to split task buckets correctly.",
    { summary: z.string().min(1).describe("One-line summary of the new intent.") },
    async ({ summary }: { summary: string }) => {
      const ev: RawEvent = {
        ts: new Date().toISOString(),
        agent: getCurrentAgent(),
        sid: getCurrentSid(),
        event: "user_intent",
        summary,
      };
      appendVoluntaryEvent(ev);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded_at: ev.ts }) }] };
    },
  );

  server.tool(
    "distill_journal",
    "Run the distillation pipeline: read raw events since the high-water mark, group by topic, write mechanical markdown entries, advance high-water. Idempotent. Auto-provisions a project row for orphan slugs (e.g. `default`) that have no registered project yet.",
    {
      project_slug: z.string().optional(),
      max_events: z.number().int().positive().max(2000).optional(),
    },
    async ({ project_slug, max_events }: { project_slug?: string; max_events?: number }) => {
      const slug = project_slug ?? getCurrentProjectSlug();
      const projectId = ensureProjectRowForSlug(slug);
      const result = await distillJournal({
        projectSlug: slug,
        projectId,
        dataDir: getDataDir(),
        maxEvents: max_events ?? 200,
        ticketRegex: /[A-Z]+-\d+/,
        openTaskWindowDays: 90,
        inFlightWindowSeconds: 300,
        now: new Date(),
        cooldownSeconds: 60,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "journal_status",
    "Report the journal backlog and high-water mark for a project.",
    { project_slug: z.string().optional() },
    async ({ project_slug }: { project_slug?: string }) => {
      const slug = project_slug ?? getCurrentProjectSlug();
      const hw = readHighWater(`${getDataDir()}/knowledge/journal`, slug);
      return { content: [{ type: "text", text: JSON.stringify({ slug, high_water: hw, mode: "lenient" }, null, 2) }] };
    },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build && node apps/mcp/test-tools.mjs`
Expected: PASS — the new test and the full smoke suite are green.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/journal-tools.ts apps/mcp/test-tools.mjs
git commit -m "fix(mcp): distill_journal auto-provisions orphan project slugs instead of erroring"
```

---

### Task 6: Envelope-suggestion nudge threshold tweak

**Files:**
- Modify: `apps/mcp/src/journal-capture.ts` (~line 124)
- Create: `apps/mcp/tests/journal-envelope-threshold.test.mjs`

**Interfaces:**
- Consumes: existing `getBacklogStatus`, `wrapHandler` (already exported from `journal-capture.ts`).
- Produces: no new exports — behavior-only change to when the `journal.suggested_action` envelope is injected into tool responses.

- [ ] **Step 1: Write the failing test**

Create `apps/mcp/tests/journal-envelope-threshold.test.mjs`:

```js
// apps/mcp/tests/journal-envelope-threshold.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  wrapHandler,
} from "../dist/journal-capture.js";

function seedRawEvents(testDir, slug, count, ageHours) {
  const dir = join(testDir, "knowledge", "journal", slug, "raw");
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  const lines = Array.from({ length: count }, () =>
    JSON.stringify({ ts, agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }),
  ).join("\n") + "\n";
  writeFileSync(join(dir, "2026-07-22.jsonl"), lines);
}

async function callWrapped() {
  const handler = wrapHandler("noop_tool", async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
  }));
  const result = await handler({});
  return JSON.parse(result.content[0].text);
}

test("envelope is NOT injected below the nudge thresholds", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 10, 0.1); // 10 events, 6 minutes old
    const body = await callWrapped();
    assert.equal(body.journal, undefined, "expected no journal envelope below thresholds");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("envelope IS injected once backlog_events crosses the event threshold", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 51, 0.1); // 51 events, still recent
    const body = await callWrapped();
    assert.ok(body.journal, "expected a journal envelope");
    assert.equal(body.journal.suggested_action, "distill_journal");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("envelope IS injected once the oldest event crosses the age threshold", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-envelope-test-"));
  try {
    setDataDir(testDir);
    initCapture({ projectSlug: "demo", baseDir: join(testDir, "knowledge", "journal"), agent: "claude-code", sid: "abc" });
    seedRawEvents(testDir, "demo", 1, 2); // 1 event, 2 hours old
    const body = await callWrapped();
    assert.ok(body.journal, "expected a journal envelope");
  } finally {
    shutdownCapture();
    rmSync(testDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/journal-envelope-threshold.test.mjs`
Expected: FAIL — the first test fails because the current code injects the envelope at `backlog_events >= 1` (10 events triggers it today).

- [ ] **Step 3: Implement the threshold tweak**

In `apps/mcp/src/journal-capture.ts`, find this block (~line 122-124):

```ts
    try {
      const status = getBacklogStatus(getCurrentProjectSlug());
      if (status.backlog_events >= 1) {
```

Replace with:

```ts
    try {
      const status = getBacklogStatus(getCurrentProjectSlug());
      const NUDGE_THRESHOLD_EVENTS = 50;
      const NUDGE_THRESHOLD_HOURS = 1;
      if (status.backlog_events >= NUDGE_THRESHOLD_EVENTS ||
          (status.backlog_oldest_age_hours ?? 0) >= NUDGE_THRESHOLD_HOURS) {
```

(No other lines in that block change — the closing braces and the rest of the `try` block stay as-is.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/journal-envelope-threshold.test.mjs`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Run the full apps/mcp test suite to check for regressions**

Run: `node apps/mcp/test-tools.mjs && node --test apps/mcp/tests/`
Expected: PASS — no existing test relied on the `>= 1` threshold (none assert on the envelope today per the codebase search performed during planning).

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/src/journal-capture.ts apps/mcp/tests/journal-envelope-threshold.test.mjs
git commit -m "fix(mcp): raise journal envelope nudge threshold to 50 events / 1h"
```

---

### Task 7: MCP wiring — start engine at boot, flush on shutdown

**Files:**
- Modify: `apps/mcp/src/index.ts`

**Interfaces:**
- Consumes: `startDistillEngine` from `kxta-core` (Task 4).
- Produces: nothing new exported — this is the final wiring point that makes the engine run in the real server process.

This task has no isolated unit test (the file is a top-level script, not an exported function — consistent with how the rest of `index.ts`'s wiring is verified in this codebase, via the smoke suite). Verification is via `pnpm build` (type check) and the existing smoke suite, which boots and kills the real server, exercising both startup and shutdown paths.

- [ ] **Step 1: Add the import**

In `apps/mcp/src/index.ts`, find the `kxta-core` import block (line 6-52) and add `startDistillEngine` after the `gracefulShutdown,` line:

```ts
  gracefulShutdown,
  startDistillEngine,
  type AgentId,
} from "kxta-core";
```

- [ ] **Step 2: Start the engine after `initCapture`**

Find (line 198):

```ts
initCapture({ projectSlug, baseDir: baseJournalDir, agent, sid });
```

Add immediately after it:

```ts
initCapture({ projectSlug, baseDir: baseJournalDir, agent, sid });

const distillEngineEnabled = process.env.KONTEXTA_DISTILL_ENGINE !== "off";
const distillEngine = distillEngineEnabled
  ? startDistillEngine({
      dataDir,
      tickMs: Number(process.env.KONTEXTA_DISTILL_TICK_MS) || 5 * 60_000,
      drainOnStart: process.env.KONTEXTA_DISTILL_DRAIN_ON_START !== "false",
      maxEventsPerSlug: Number(process.env.KONTEXTA_DISTILL_MAX_EVENTS) || 500,
    })
  : null;
```

- [ ] **Step 3: Flush the engine on shutdown**

Find `handleShutdownSignal` (lines 205-218):

```ts
async function handleShutdownSignal(signal: string) {
  console.warn(`[kontexta-mcp] received ${signal}; draining…`);
  killAllActiveChildren("SIGTERM");
  shutdownCapture();
  try {
    const remaining = await gracefulShutdown(10_000);
    if (remaining > 0) {
      console.warn(`[kontexta-mcp] drain timeout; ${remaining} ops still in-flight at exit`);
    }
  } catch (err) {
    console.warn(`[kontexta-mcp] gracefulShutdown failed`, err);
  }
  process.exit(0);
}
```

Replace with:

```ts
async function handleShutdownSignal(signal: string) {
  console.warn(`[kontexta-mcp] received ${signal}; draining…`);
  killAllActiveChildren("SIGTERM");
  if (distillEngine) {
    await Promise.race([
      distillEngine.stop({ flush: true }),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }
  shutdownCapture();
  try {
    const remaining = await gracefulShutdown(10_000);
    if (remaining > 0) {
      console.warn(`[kontexta-mcp] drain timeout; ${remaining} ops still in-flight at exit`);
    }
  } catch (err) {
    console.warn(`[kontexta-mcp] gracefulShutdown failed`, err);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build`
Expected: builds succeed with no TypeScript errors.

- [ ] **Step 5: Run the full smoke suite**

Run: `node apps/mcp/test-tools.mjs`
Expected: PASS — the server boots with the engine running and shuts down cleanly (via `child.kill()` at the end of the suite, which exercises the `SIGTERM` → `handleShutdownSignal` → `distillEngine.stop({flush:true})` path) within the existing timeouts.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/src/index.ts
git commit -m "feat(mcp): start journal distillation engine at boot, flush on shutdown"
```

---

### Task 8: End-to-end integration test

**Files:**
- Create: `apps/mcp/tests/journal-engine.test.mjs`

**Interfaces:**
- Consumes: `startDistillEngine`, `registerProject`, `createDatabase`, `closeDatabase`, `getDatabase` from `kxta-core`; `initCapture`, `shutdownCapture`, `setDataDir`, `wrapHandler` from `../dist/journal-capture.js`.
- Produces: nothing — this is the capstone test proving the full feature works together, covering both the orphan-slug path (capture → engine → synthetic project → promotion) and the already-registered path (engine reuses the existing project id, no synthetic duplicate).

- [ ] **Step 1: Write the test**

Create `apps/mcp/tests/journal-engine.test.mjs`:

```js
// apps/mcp/tests/journal-engine.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase, startDistillEngine, registerProject } from "kxta-core";
import {
  initCapture,
  shutdownCapture,
  setDataDir,
  wrapHandler,
} from "../dist/journal-capture.js";

test("distillation engine drains an orphan slug's backlog end-to-end", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-e2e-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    setDataDir(testDir);
    // No project row for "default" — this is the orphan-slug scenario.
    initCapture({
      projectSlug: "default",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "eng-e2e",
    });

    const okTool = wrapHandler("update_file", async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    await okTool({ path: "notes.md" });
    await okTool({ path: "notes.md" });

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date(Date.now() + 6 * 60_000), // 6 min ahead of the events just written
    });

    let tickResult;
    try {
      tickResult = await engine.tickNow();
    } finally {
      await engine.stop();
    }

    assert.ok(tickResult.slugs_distilled >= 1, `expected ≥1 slug distilled, got ${JSON.stringify(tickResult)}`);

    const db = getDatabase();
    const project = db.prepare("SELECT * FROM projects WHERE slug = ?").get("default");
    assert.ok(project, "expected an auto-provisioned project row for 'default'");
    assert.equal(project.path, null, "synthetic project should have path=NULL");

    const distilledRoot = join(testDir, "knowledge", "journal", "default");
    const yearDirs = readdirSync(distilledRoot).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected at least one YYYY/ directory");

    // Promote the synthetic project to a real one; distilled entries must
    // stay linked to the same project_id (no orphaned journal_meta rows).
    const promoted = registerProject("Default", join(testDir, "real-project-path"));
    assert.equal(promoted.id, project.id, "promotion should keep the same project id");
    assert.equal(promoted.path, join(testDir, "real-project-path"));

    const metaCount = db.prepare("SELECT COUNT(*) AS c FROM journal_meta WHERE project_id = ?").get(project.id);
    assert.ok(metaCount.c > 0, "expected journal_meta rows still linked to the promoted project");
  } finally {
    shutdownCapture();
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("engine uses an already-registered project directly (no synthetic duplicate)", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-registered-"));
  try {
    createDatabase(join(testDir, "kontexta.db"));
    setDataDir(testDir);

    const registered = registerProject("Scratch", join(testDir, "scratch-project"));
    assert.equal(registered.slug, "scratch");

    initCapture({
      projectSlug: "scratch",
      baseDir: join(testDir, "knowledge", "journal"),
      agent: "claude-code",
      sid: "eng-registered",
    });

    const okTool = wrapHandler("update_file", async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    await okTool({ path: "notes.md" });

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date(Date.now() + 6 * 60_000),
    });
    try {
      const tickResult = await engine.tickNow();
      assert.ok(tickResult.slugs_distilled >= 1, `expected ≥1 slug distilled, got ${JSON.stringify(tickResult)}`);
    } finally {
      await engine.stop();
    }

    const db = getDatabase();
    const rows = db.prepare("SELECT * FROM projects WHERE slug = ?").all("scratch");
    assert.equal(rows.length, 1, "expected exactly one project row for slug 'scratch', no synthetic duplicate");
    assert.equal(rows[0].id, registered.id, "distillation should reuse the registered project id");
    assert.equal(rows[0].path, join(testDir, "scratch-project"), "registered path must be untouched");

    const distilledRoot = join(testDir, "knowledge", "journal", "scratch");
    const yearDirs = readdirSync(distilledRoot).filter((f) => /^\d{4}$/.test(f));
    assert.ok(yearDirs.length > 0, "expected distilled entries under the registered slug");
  } finally {
    shutdownCapture();
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail first (sanity check on a clean tree)**

Run: `git stash && pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/journal-engine.test.mjs; git stash pop`
Expected: FAIL — `startDistillEngine is not exported from 'kxta-core'` (confirms the tests genuinely exercise Tasks 1-7's changes and aren't vacuously passing). Skip this step if Tasks 1-7 are already committed in the working tree — in that case just run the tests directly and confirm PASS.

- [ ] **Step 3: Run the tests on the real (post-Task-7) tree to verify they pass**

Run: `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/journal-engine.test.mjs`
Expected: PASS — both tests green.

- [ ] **Step 4: Run the full test matrix for a final regression check**

Run: `pnpm build && pnpm test`
Expected: PASS — this runs `vitest run` across `packages/core` (Tasks 1-4's tests) and `node test-tools.mjs` for `apps/mcp` (Task 5's new smoke test), per the root `turbo test` pipeline. Then separately run: `node --test apps/mcp/tests/` to cover the `node:test` files (`journal-engine.test.mjs`, `journal-envelope-threshold.test.mjs`, and the pre-existing suite), since those aren't wired into `pnpm test` today.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/tests/journal-engine.test.mjs
git commit -m "test(mcp): add end-to-end test for orphan-slug distillation and promotion"
```

---

### Task 9: Manual smoke test against the real data directory

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Back up the real data dir**

Run: `cp -R ~/Library/Application\ Support/kontexta ~/Library/Application\ Support/kontexta.bak-$(date +%Y%m%d)`
Expected: a timestamped backup directory exists alongside the original.

- [ ] **Step 2: Build the updated MCP server**

Run: `pnpm build`
Expected: builds succeed with no errors.

- [ ] **Step 3: Start the MCP server against the real data dir and watch it drain**

Run: `node apps/mcp/dist/index.js` (foreground; the real `KONTEXTA_DATA_DIR` default applies since it isn't overridden)
Expected: within ~10 seconds (the `drainOnStart` immediate tick), the process log shows no `[distill-engine]` warnings. Leave it running for one more full tick interval (5 minutes) or press Ctrl+C after confirming step 4 below.

- [ ] **Step 4: Verify the `default` backlog drained**

In a second terminal, run: `ls ~/Library/Application\ Support/kontexta/knowledge/journal/default/`
Expected: a `2026/` directory now exists alongside `raw/`, and `raw/.distilled-up-to.json` — wait, the high-water file lives at `default/.distilled-up-to.json` directly (not inside `raw/`). Run: `cat ~/Library/Application\ Support/kontexta/knowledge/journal/default/.distilled-up-to.json` — expected: a JSON object with `last_event_ts` at or near today's date (2026-07-22), not the earlier `2026-06-26` recorded for the `slt` slug.

- [ ] **Step 5: Verify the synthetic project row**

Send the server (still running from Step 3, or a fresh instance) a `list_projects` call via any connected MCP client (e.g. this Claude Code session's `mcp__kxta__list_projects` tool). Expected: a project entry with `name: "Default (unregistered work)"`, `slug: "default"`, `path: null`.

- [ ] **Step 6: Clean up**

Stop the server (Ctrl+C — this exercises the real `SIGINT` → `handleShutdownSignal` → flush path). If everything looks correct, remove the backup: `rm -rf ~/Library/Application\ Support/kontexta.bak-$(date +%Y%m%d)`. If anything looks wrong, restore from the backup instead of debugging live data.
