# Journal Distillation Engine — Design

**Date:** 2026-07-22
**Goal:** Make journal distillation happen reliably for every project slug that receives raw events, **including unregistered directories** (home directory, ad-hoc scripts, random repos). Today, raw events land on disk for any cwd, but distillation is gated on a matching row in the `projects` table — so the `default` slug (where all unregistered work goes) has never distilled a single event.

**Scope:**
- New in-process background engine started by MCP `main()`, stopped on shutdown. Ticks every 5 minutes; also drains at startup and flushes on graceful shutdown.
- Auto-provisions a synthetic `projects` row for any orphan slug on first distill (no schema change; `projects.path` is already nullable).
- One shared `default` slug remains the bucket for all unregistered cwds (per user decision — no per-cwd sharding).
- Small tightening of the existing envelope-suggestion threshold so the agent isn't nudged when the engine is keeping up.
- Small `register_project` upsert tweak so a user can later promote a synthetic project to a real one without hitting the slug-uniqueness constraint.

**Non-goals:**
- No schema migration (`journal_meta.project_id` stays `NOT NULL`).
- No external process — no launchd, no CLI daemon. The engine is exported from core, so a future CLI wrapper is trivial, but that's out of scope.
- No change to the raw-event writer, `distillJournal` internals, strict-mode, or housekeeping.
- No cleanup of the pre-existing `slt`-slug backlog (that predates the July slug flip and is a one-off manual task, not an engine concern).

---

## Mechanism

### 1. New module: `packages/core/src/journal/engine.ts`

Public API:

```ts
export interface StartEngineOpts {
  dataDir: string;                               // <data>
  tickMs?: number;                               // default 5 * 60_000
  drainOnStart?: boolean;                        // default true
  maxEventsPerSlug?: number;                     // default 500
  onError?: (err: unknown, slug: string) => void;
  now?: () => Date;                              // for tests
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

export function startDistillEngine(opts: StartEngineOpts): EngineHandle;
```

### 2. Lifecycle

1. **Start**
   - Validate `dataDir` exists.
   - If `drainOnStart` (default `true`), schedule `tickNow()` on `setImmediate` — non-blocking so MCP init doesn't wait on it.
   - `setInterval(tickNow, tickMs)`; the timer is `.unref()`'d so it never holds the process open on its own.
   - Return `EngineHandle`.

2. **Tick (`tickNow`)**
   - Serialization: an internal `running: Promise<TickResult> | null` flag. A tick fired while one is in progress returns the in-flight promise instead of stacking.
   - `slugs = listSlugsWithBacklog(dataDir)` (see §3).
   - For each slug:
     - `try { ensureProjectRowForSlug(slug); await distillJournal({...}); } catch (err) { onError(err, slug); }`
     - One failing slug never blocks the next.
   - Returns `TickResult`.

3. **Stop**
   - `clearInterval(timer)`.
   - If `flush: true` (default when called from graceful shutdown), await one final `tickNow()`.
   - Idempotent — a second `stop()` is a no-op.

### 3. Slug enumeration & backlog probing

`listSlugsWithBacklog(dataDir): string[]`:

1. `readdirSync(<dataDir>/knowledge/journal, { withFileTypes: true })` → filter to directories.
2. For each slug dir, cheap backlog probe (no JSONL parsing):
   - `hwPath = <slug>/.distilled-up-to.json`
   - `rawDir = <slug>/raw`
   - If `rawDir` doesn't exist → slug is clean.
   - If `hwPath` missing → slug is dirty.
   - Else compare `mtime(rawFile)` for each raw file vs `mtime(hwPath)`. If any raw file is newer → dirty. Track newest raw mtime for sort key.
3. Return dirty slugs sorted by newest raw mtime **descending** (most-recent work distills first).

This is intentionally an mtime-only heuristic. It can over-report (a raw file touched but with no new events past the recorded high-water) but `distillJournal` is idempotent and will just return `events_processed: 0` — a cheap no-op is fine, false negatives (missing new events) are not.

### 4. Synthetic project provisioning

`ensureProjectRowForSlug(slug: string): number`:

```
SELECT id FROM projects WHERE slug = ?
```
If found → return `id`.

Otherwise insert:
```sql
INSERT INTO projects (name, slug, description, path)
VALUES (?, ?, ?, NULL)
```

- `slug` — as given.
- `name` — `default` maps to `"Default (unregistered work)"`; other slugs titlecase to e.g. `"Scratch"`. If `name` collides with an existing project name (UNIQUE), suffix with `" (auto)"`, then a counter as needed.
- `description` — `"Auto-provisioned by distillation engine for orphan slug '<slug>'."`
- `path` — `NULL`. **This is the marker that the row is synthetic.**

Wrapped in a SQLite transaction. If two MCP instances race the insert, the UNIQUE constraint on `slug` will fail one of them; catch the constraint error and re-`SELECT`.

`ensureProjectRowForSlug` is exported from core and used in **two** places: the engine's tick, and the `distill_journal` MCP tool (`apps/mcp/src/journal-tools.ts:62`), which today returns `unknown project_slug` for orphan slugs. The tool switches from erroring to provisioning — so a manual `distill_journal` call on `default` works even before the engine's first tick, and both paths share one behavior.

### 5. `register_project` upsert-on-synthetic

`registerProject()` lives at `packages/core/src/metadata/index.ts:195`. Today it does `INSERT OR IGNORE`, then on `changes === 0` looks the row up by name/slug and throws `PROJECT_CONFLICT` when `existing.path !== absolutePath`. A synthetic row has `path IS NULL`, so promoting it to a real project currently throws.

Change: in the "insert was ignored" branch, when the existing row's `path IS NULL`, `UPDATE` it in place — populate `path`, `name`, `description`, `remote_url` from the call — and return the existing `id` (do not throw). If the new `name` would violate the UNIQUE constraint (some other project already uses it), keep the synthetic name, update the rest, and surface a warning in the tool response. The existing name/slug conflict paths (rows with non-null path) stay unchanged.

This makes the promotion path clean: a synthetic slug becomes a fully-registered project without losing the distilled entries already keyed to its `project_id`.

### 6. MCP wiring — `apps/mcp/src/index.ts`

MCP already has a shutdown pathway: `process.on("exit", shutdownCapture)` (line 201) and `handleShutdownSignal(...)` bound to `SIGINT`/`SIGTERM` (lines 207–221). We piggyback on that — no new signal handlers.

Near existing `initCapture(...)`, after DB init:

```ts
const engineEnabled = process.env.KONTEXTA_DISTILL_ENGINE !== "off";
const engine = engineEnabled ? startDistillEngine({
  dataDir: getDataDir(),
  tickMs: Number(process.env.KONTEXTA_DISTILL_TICK_MS) || 5 * 60_000,
  drainOnStart: process.env.KONTEXTA_DISTILL_DRAIN_ON_START !== "false",
  maxEventsPerSlug: Number(process.env.KONTEXTA_DISTILL_MAX_EVENTS) || 500,
}) : null;
```

Inside `handleShutdownSignal(...)`, before `shutdownCapture()`:
```ts
if (engine) await Promise.race([
  engine.stop({ flush: true }),
  new Promise((r) => setTimeout(r, 10_000)),
]);
```

The timeout guard keeps shutdown snappy: a flush tick is normally sub-second, but a cold 500-event backlog across several slugs shouldn't be able to hold the process hostage. An interrupted flush is safe — `distillJournal` is idempotent and the next start's drain recovers.

Numeric env parsing is defensive but simple: `Number(undefined) → NaN`, `NaN || fallback → fallback`. Same trick works for typos and empty strings.

### 7. Envelope-suggestion threshold tweak — `apps/mcp/src/journal-capture.ts`

Current behavior (line ~124): `if (status.backlog_events >= 1) { inject suggested_action }`.

With the engine on, backlog will normally be `<50` and freshly-cleared. Change to:

```ts
const NUDGE_THRESHOLD_EVENTS = 50;
const NUDGE_THRESHOLD_HOURS = 1;
if (status.backlog_events >= NUDGE_THRESHOLD_EVENTS ||
    (status.backlog_oldest_age_hours ?? 0) >= NUDGE_THRESHOLD_HOURS) {
  // inject suggested_action envelope
}
```

The existing fire-and-forget fallback at `backlog >= 500 OR >= 7d` is now redundant when the engine is on, but it's a cheap tripwire for cases where the engine is disabled or has been failing — keep it as-is.

### 8. Configuration

All optional; read once at `startDistillEngine` call time (no hot reload).

| Env var | Default | Purpose |
|---|---|---|
| `KONTEXTA_DISTILL_ENGINE` | `"on"` | `"off"` disables the engine entirely. |
| `KONTEXTA_DISTILL_TICK_MS` | `300000` | Tick cadence in ms. |
| `KONTEXTA_DISTILL_DRAIN_ON_START` | `"true"` | `"false"` skips the startup drain. |
| `KONTEXTA_DISTILL_MAX_EVENTS` | `500` | Per-slug event cap per tick. |

### 9. Concurrency

- **Within one process:** `running` flag collapses overlapping ticks to one.
- **Across processes (two MCP instances):** the existing `acquireCooldown(baseDir, slug, cooldownSeconds)` in `distill.ts` handles this via a filesystem lock keyed by slug. Both engines' ticks will attempt, one wins, the other's call returns `{ warnings: ["cooldown active"] }` — a clean no-op.

### 10. Errors

- Per-slug failures route to `onError(err, slug)`; default `console.warn("[distill-engine] slug=%s", slug, err)`.
- Ticker itself is wrapped in a top-level try/catch; the interval keeps ticking even if one tick throws unexpectedly.
- Startup-drain failures never prevent the periodic tick from being scheduled.

---

## Files touched

**New:**
- `packages/core/src/journal/engine.ts` — engine implementation.
- `packages/core/tests/journal/engine.test.ts` — unit tests.
- `apps/mcp/tests/journal-engine.integration.test.ts` — end-to-end MCP test.

**Modified:**
- `packages/core/src/journal/index.ts` — export `startDistillEngine`, `EngineHandle`, `StartEngineOpts`.
- `packages/core/src/metadata/index.ts:195` (`registerProject`) — upsert-on-synthetic.
- `apps/mcp/src/index.ts` — start engine after DB init; call `engine.stop({ flush: true })` (with 10 s timeout race) inside the existing `handleShutdownSignal(...)` before `shutdownCapture()`.
- `apps/mcp/src/journal-tools.ts` (~line 62) — `distill_journal` tool provisions orphan slugs via `ensureProjectRowForSlug` instead of erroring.
- `apps/mcp/src/journal-capture.ts` (~line 124) — tighten envelope-suggestion threshold to 50 events / 1 h.

## Tests

**Unit — `engine.test.ts`:**
- Enumeration returns dirty slugs only, mtime-desc.
- `ensureProjectRowForSlug`: fresh DB → creates row with `path IS NULL`, correct derived name; idempotent; race-safe under `Promise.all`.
- `register_project` upsert-on-synthetic: pre-insert synthetic → `register_project` populates path and name in place, returns same id; name-collision case keeps synthetic name and warns.
- `distill_journal` tool on orphan slug: provisions the row and distills instead of returning `unknown project_slug`.
- Tick behavior: distills dirty slug, skips clean slug, one failing slug doesn't block others.
- Lifecycle: interval scheduled, `.unref()`'d; `stop({ flush: true })` awaits final tick; `stop()` idempotent.

**Integration — `journal-engine.integration.test.ts`:**
- Boot MCP against tmp `KONTEXTA_DATA_DIR` with `KONTEXTA_DISTILL_TICK_MS=200`.
- Invoke a couple of tool calls (raw events written to `default/`), wait one tick, assert `default/YYYY/MM/DD/task-*.md` files exist, `.distilled-up-to.json` advanced, synthetic `default` project row created.
- Repeat with a `register_project` first; assert distilled entries land under the registered slug (not `default`) and no duplicate synthetic row.

**Manual smoke:**
- Run the modified MCP against the user's real data dir. Expected: within ~10 s of MCP start (drainOnStart), the 273-event `default/` backlog drains, `default/` gets a synthetic project row, and subsequent tool calls stay near zero backlog.

## Rollout & risk

- **Rollout:** merge as one PR; engine defaults to on. If it misbehaves in the field, `KONTEXTA_DISTILL_ENGINE=off` restores prior behavior with zero code change.
- **Risk 1 — misfire noise:** if the ticker fires while a heavy tool call is running, disk I/O contention. Mitigated by the 5-min cadence and per-slug cooldown lock.
- **Risk 2 — orphan `default` row appearing in `list_projects`:** by design; documented via description. Users can rename it or promote via `register_project`.
- **Risk 3 — SIGKILL leaves in-flight tick incomplete:** acceptable; next MCP start's drain-on-start recovers. `distillJournal` writes are idempotent (upserts + high-water advance).
- **Risk 4 — `register_project` upsert changes behavior for existing users:** only when the existing row has `path IS NULL`, which today means a bug or a manual insert; low blast radius.
