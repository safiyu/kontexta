# Design: App-Level Logs

**Status:** Draft
**Date:** 2026-05-18
**Scope:** Minimal observability layer for v1. Structured backend logging + a UI panel that surfaces it to the user. Solves audit point 1 ("Observability is a hole").

---

## 1. Motivation

The audit identified that the codebase has scattered `console.error()` calls and silent `catch {}` blocks, with no persisted log and no way for users to see what's happening. When something goes wrong (a tool call fails, a git sync errors, the file watcher misses an event), neither the user nor a debugging maintainer has a record to look at.

This spec defines the smallest possible thing that fixes that: one log file, one viewer.

## 2. Non-Goals

- **Per-module log level configuration.** One global level for v1.
- **Multiple sinks.** File only. No stdout, no remote.
- **External services.** No Sentry, Datadog, OpenTelemetry, etc.
- **A `kontexta doctor` command.** Future work — reads the same log file but is its own surface.
- **Replacing every `console.error` in the codebase.** Targeted replacement in the highest-signal paths (MCP tool calls, web API routes, watcher, journal scheduler, git wizard). Drive-by replacements OK; full audit is post-v1.

## 3. Data Model

Each log entry is one JSON line:

```json
{"ts":"2026-05-18T15:32:11.420Z","level":"warn","source":"mcp.search","msg":"FTS query syntax error","data":{"query":"foo )(("}}
```

| Field | Type | Notes |
|---|---|---|
| `ts` | ISO 8601 string | UTC, millisecond precision |
| `level` | `"debug" \| "info" \| "warn" \| "error"` | Single global threshold (default `info`) |
| `source` | string | Dotted path like `mcp.search`, `web.api.files`, `watcher`, `journal.scheduler`, `git.sync` |
| `msg` | string | One-line human-readable summary |
| `data` | object \| undefined | Optional structured fields. Errors get `{err: {message, stack, name}}`. |

## 4. Storage

- **Path:** `<dataDir>/logs/kontexta.log`
- **Rotation:** when the file exceeds 10 MB, rename to `kontexta.log.1` (overwriting any existing `.1`). One backup, no further rotation. This is intentional: minimal disk usage, recent history only.
- **Concurrency:** every Node process appending to the same file. Append-only writes with `O_APPEND` are atomic for writes < 4 KB on POSIX. We don't lock — interleaved entries are acceptable; each line is self-contained.
- **Read path:** the API streams the file (most recent first via reverse scan), applies filters in memory, returns up to N entries.

## 5. API Surface (logger module)

Lives in `packages/core/src/logger.ts`. Exports:

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  ts: string; level: LogLevel; source: string; msg: string; data?: Record<string, unknown>;
}
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown> | Error): void;
  child(suffix: string): Logger;  // source = parent.source + "." + suffix
}
export function getLogger(source: string): Logger;
export function setLogLevel(level: LogLevel): void;       // global threshold
export function readRecentLogs(opts: {
  limit?: number;             // default 500, max 5000
  source?: string;            // exact match or dot-prefix
  level?: LogLevel;           // entries at or above this level
  search?: string;            // substring across msg + JSON.stringify(data)
}): LogEntry[];
```

Log level threshold reads from `KONTEXTA_LOG_LEVEL` env var (default `info`).

## 6. Wiring (Backend Replacements)

This is the targeted list — not a full audit. Specific files where silent catches or `console.error` calls hurt most:

- `apps/mcp/src/index.ts` — top-level MCP tool error handlers
- `apps/web/src/lib/auth.ts` — silent `catch {}` blocks around settings reads
- `apps/web/src/app/api/**/route.ts` — error responses log before returning 500
- `packages/core/src/watcher/*` — file-watch errors
- `packages/core/src/journal/scheduler.ts` (or equivalent) — scheduler tick failures
- `packages/core/src/git/*` — git command failures

Each module gets `const log = getLogger("source.name")` at top, replaces relevant `console.error`/`catch {}` blocks.

## 7. Web API

New route: `GET /api/logs?limit&source&level&search`

- Auth-gated using existing `checkAuth` middleware
- Returns `{entries: LogEntry[]}`
- Limits enforced server-side (max 5000)

## 8. Web UI

New "Logs" view, accessible from the top bar (icon button next to existing controls). Modal or slide-in panel — match existing dashboard patterns.

**Layout:**
- Header row: level filter (4 checkboxes), source filter (multi-select dropdown populated from distinct sources in the current entries), search input, auto-refresh toggle (5s poll), clear-filters button
- Body: vertical list of entries, newest at top. Each row shows: relative time + absolute time on hover, level (colored chip), source (mono), msg. Click to expand `data` as pretty JSON.
- Footer: "Showing N of M total" + a "Download log" button (downloads raw file)

**No real-time streaming** in v1. Auto-refresh polling is enough.

## 9. Architecture & File Layout

**New files:**
- `packages/core/src/logger.ts` — the logger module
- `packages/core/src/logger.test.ts` — vitest unit tests
- `apps/web/src/app/api/logs/route.ts` — GET handler
- `apps/web/src/app/api/logs/route.test.ts`
- `apps/web/src/components/logs/logs-panel.tsx` — the main view
- `apps/web/src/components/logs/log-row.tsx` — single entry row
- `apps/web/src/components/logs/logs-panel.test.tsx`

**Modified files** (wiring, ~5–10 lines each):
- `packages/core/src/index.ts` — export logger
- `apps/mcp/src/index.ts` — log MCP tool errors
- `apps/web/src/lib/auth.ts` — log auth lookup failures
- `apps/web/src/components/layout/top-bar.tsx` — add "Logs" button
- Each chosen route/watcher file — replace one or two calls

## 10. Estimated Effort

- Logger module + tests: ~150 LOC + 100 LOC tests, 0.5 day
- API route + tests: ~80 LOC + 60 LOC tests, 0.5 day
- UI panel + filters + tests: ~250 LOC + 100 LOC tests, 1 day
- Backend wiring (6 files): ~50 LOC total, 0.5 day
- **Total: ~2.5 days. ~600 production LOC + 260 test LOC.**

## 11. Open Questions / Deferred

- **Sensitive data in logs.** No automatic redaction in v1. Module authors are responsible. Document in core README.
- **Performance under load.** A high-traffic MCP server could write thousands of entries/sec. Out of scope — kontexta is local-first single-user.
- **Log retention beyond the 10MB+10MB rolling window.** Out of scope.
- **`kontexta doctor` CLI.** Future spec.
