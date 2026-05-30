# Changelog

## 2.0.3 — Test suite stabilization & UI authentication integration

### Fixed

- **`install-templates` test**: skips the `dataDir` assertion for the `aider` client — Aider is file-based and does not embed an MCP data-directory path in its snippet body.
- **`hand-tool-templates` test**: updated expected template count from 4 → 8 to reflect the full set of shipped templates (`npm-install`, `type-check`, `lint-fix`, `comprehensive-example` added since the snapshot was created). Fixed the `comprehensive-example` template's `command` to use `bash ./scripts/deploy.sh …` (bare command, not a relative path) so it passes `validateConfig`'s argv[0] validation. Snapshot regenerated.
- **`save-bar` test**: aligned label assertions to actual component output — `"1 change"` / `"3 changes"` (component uses the concise form, not `"unsaved change(s)"`).
- **`tool-form-modal` test**: broadened the submit-button name query to `/(save|create)/i` to cover both the `"Save Changes"` (edit) and `"Create Tool"` (new) labels that `ToolForm` emits depending on context.
- **`builder-section` tests**: full rewrite to match the three-pane inline-editor UI (left Registry sidebar, centre inline `ToolForm` editor, right Template Gallery) that replaced the old modal/list pattern. Covers: initial load, staged deletion, empty-state gallery, save-bar count lifecycle, template-prefill flow, from-scratch creation, config-file deletion, and per-tool validation error badges.
- **Native module compatibility**: recompiled `re2` and `better-sqlite3` for Node.js v24.15.0.

### Changed

- **`hand-tool-templates`**: `comprehensive-example` command changed from `./scripts/deploy.sh …` → `bash ./scripts/deploy.sh …` to satisfy the `argv[0] must be absolute or a bare command` constraint enforced by `validateConfig`.

### Tests

- **`apps/web` suite**: 25 test files / 104 tests — all passing (was 5 failing suites).
- Total monorepo suite unchanged for `packages/core` and `apps/mcp` (both were already green).

## 2.0.2 — Housekeep refuses to prune undistilled raw events

### Fixed

- **`housekeep_journal` now refuses to prune any raw `.jsonl` file containing events newer than the project's high-water mark.** Previously, an aggressive `retention.raw_days` config (e.g. `1`) combined with stalled distillation could delete raw events before they were ever captured into the durable distilled `.md` layer — irrecoverable data loss. The new guard reads the file's last event timestamp; if it's past the high-water (or no high-water exists at all), the file is preserved and counted under a new `raw_files_skipped_undistilled` field in the result.
- This is the cheap mitigation for the "two-step grace pruning" item that was on the roadmap; the full grace mechanism is no longer needed because the only real data-loss failure mode is now closed.

### Tests

- 4 housekeep tests (was 2): the "prunes" test now seeds proper events + a high-water mark; new tests cover (a) refusing to prune files with events past the mark, (b) refusing to prune anything when no high-water exists yet. Total core suite: 243 passing.

## 2.0.1 — Graceful DB shutdown drain

### Fixed

- **MCP signal handlers now drain in-flight work before exiting.** Previously `SIGINT`/`SIGTERM` killed Hands children, flushed the journal capture, then called `process.exit(0)` immediately — `closeDatabase()` was never invoked, and any long-running `withLock`-protected op (`updateFile`, `commitBackup`, `syncBackup`, `refreshIndex`, journal append) could be truncated mid-write. SQLite WAL mode mostly recovered, but partial markdown writes and orphaned file descriptors leaked across shutdowns.
- New `gracefulShutdown(timeoutMs = 10_000)` helper exported from `kxta-core`: sets a shutdown flag, awaits in-flight count to reach zero (with a hard ceiling), then closes the database cleanly. Returns the count of ops still in-flight at timeout (0 = clean drain).
- In-flight bookkeeping is centralized inside `withLock` itself — every long-running op already routes through `withLock`, so this gives ~95% coverage with zero per-site instrumentation. A standalone `track<T>(p)` helper is also exported for the rare op that bypasses `withLock`.
- New helpers from `kxta-core`: `track`, `inFlightCount`, `isShuttingDown`, `setShuttingDown`, `awaitDrain`, `gracefulShutdown`.
- MCP signal handlers replaced with an async `handleShutdownSignal()` that: kills Hands children → flushes journal capture → awaits `gracefulShutdown(10_000)` → exits. A `_shutdownInFlight` guard prevents repeated `Ctrl+C` from racing.

### Tests

- 8 new vitest cases in `packages/core/tests/util/shutdown.test.ts` covering counter increment/decrement (success + rejection paths), `track()` correctness, `awaitDrain` zero-state and timeout-state, and shutdown-flag toggling. Total core suite: 241 passing (was 233).

## 2.0.0 — Journaling: persistent Brain layer with auto-capture + mechanical distillation

A new always-on journaling subsystem turns kontexta into a persistent Brain across sessions. Every MCP tool call is automatically captured to a per-project event log; events get distilled into per-topic markdown summaries indexed alongside the rest of the knowledge base. Closed the loop on cross-session, cross-agent memory.

### Added — Layer 1: automatic capture (zero agent involvement)

- **Per-project append-only JSONL event log** at `data/knowledge/journal/<project>/raw/YYYY-MM-DD.jsonl`. Every MCP tool call writes one event with `ts`, `agent`, `sid`, `tool`, redacted `args`, `touched` files, `status`, `ms`. Per-event `fsync` for crash safety; survives kill -9 / power loss.
- **MCP server-side wrapping** via a 24-line `server.tool` monkey-patch in `apps/mcp/src/index.ts` — every existing and future tool registration is auto-wrapped at boot. Zero per-handler edits, zero risk of agents skipping logging.
- **Redaction** of sensitive args (`password|token|secret|auth|cookie|bearer|api[_-]?key`) plus configurable `extra_keys` and `max_arg_size_bytes`. Truncates oversized strings; recurses into nested objects.
- **Git context awareness**: poller emits `git_context` events on branch changes and `git_commit` events when HEAD advances. Surfaces ticket IDs (configurable regex, default `[A-Z]+-\d+`), branch names, commit shas in the journal index for cross-references.
- **Voluntary semantic events**: new `journal_note(text, tags?)` and `journal_intent(summary)` MCP tools let agents enrich the log with decisions, abandonments, and topic pivots in real time.

### Added — Layer 2: mechanical distillation

- **`distill_journal` MCP tool** runs the read → group → render → index → advance pipeline. Idempotent; safe to call repeatedly; respects a per-project cooldown lock.
- **Topic detection** groups events into per-task buckets by branch/ticket-id continuity, touched-files overlap, or freshly-minted slugs from branch basenames. Stable slugs across runs; existing tasks reactivate automatically when matching events appear.
- **10 built-in pattern detectors**: `error-recovery-cycle`, `exploration`, `test-cycle`, `pivot`, `build-failure-recovery`, `refactor`, `incident-response`, `feature-development`, `tagging-pass`, `read-only-investigation`. Each is a small state machine over the event stream that produces a labeled summary.
- **`extra_patterns` declarative config** in `kontexta.json` lets users add custom patterns without code (`tag_any`, `tag_all`, `tool_any`, `min_events`, `max_events`).
- **Mechanical markdown renderer** writes per-task files at `data/knowledge/journal/<project>/YYYY/MM/DD/task-<slug>.md` with full frontmatter (touched files, git refs, ticket IDs, status, started/last_active timestamps, raw-source provenance). Files are indexed automatically via the existing FTS5 watcher.

### Added — SQL index

- **Migration `004-journaling.sql`** introduces:
  - `journal_meta` (file_id, project_id, task_slug, status_latest, started_at, last_active_at, touched_files, raw_sources)
  - `journal_touches` (file_id, touched_path) — indexable many-to-many for "every entry that touched X.ts"
  - `journal_git_refs` (file_id, ref_type ∈ {branch,commit,ticket}, ref_value) — indexable lookup for "every entry related to INC-1234" or "near commit a8b291c"
  - `journal_high_water` (project_slug, last_event_ts, last_distilled_at, events_processed)

### Added — Enforcement modes (configurable per project)

- **`lenient`** (default) — never blocks; injects a `journal` envelope on every tool response when backlog ≥ 1 (visible nag with `suggested_action: "distill_journal"`); auto-fires mechanical distillation in the background when backlog crosses 500 events or 7 days.
- **`strict`** — blocks read tools (`search`, `read_*`, `list_*`, `describe_*`) with a `JOURNAL_BACKLOG` error when undistilled events exist. Write tools and `journal_*` tools are not affected. Override on a single call with `journal_bypass: true` (logged for audit).
- **`mechanical-only`** — disables LLM-upgrade tier guidance; mechanical distillation runs every N tool calls in-process.

### Added — Housekeeping

- **`housekeep_journal` MCP tool** prunes raw `.jsonl` files past `retention.raw_days` and archives cold tasks (last_active_at > `retention.archive_cold_after_days`) to `_archive/` with the DB row updated. Idempotent.
- Configurable retention defaults: `raw_days: 90`, `mechanical_only_days: 365`, `narrative_days: 0` (forever), `archive_cold_after_days: 365`.

### Added — WebUI

- **`Settings → Journal` panel** at `/docs?tab=journal`. Form controls for mode, retention, ticket pattern, scheduler enable + intervals. Mirrors the existing Hands editor pattern: read full `kontexta.json` → modify only the `journal.*` slice → write back. **Hands editor untouched.**
- **Live status block** auto-refreshes every 30s (and on WebSocket `journal_status_update` events). Shows current high-water, events processed, open tasks count + first 20 task summaries.
- **API routes**: `GET/PUT /api/projects/[id]/journal-config` and `GET /api/projects/[id]/journal-status`.
- **`JournalScheduler`** runs inside the Next.js instrumentation hook (when the dashboard is installed) — mechanical distillation every 15 minutes, housekeeping every 24 hours. Defers per project when MCP is active (presence signal: `.jsonl` mtime within 30s).
- **WebSocket broadcast** of `journal_status_update` events when scheduled distillation produces work.

### Added — Cross-cutting

- **`distill_journal_commit_upgrades` MCP tool** closes the subagent-dispatch loop: after agents dispatch subagents to upgrade mechanical entries to LLM narrative, this updates `journal_meta.status_latest` to mark them as upgraded.
- **Cooldown lock** (`.distill.lock` file per project) prevents MCP-side and WebUI-side distillation from racing.
- **`onboard_agent` hook snippets**: response now surfaces optional `SessionStart`, `Stop`, and `PostToolUse` hook snippets users can paste into `~/.claude/settings.json`. The snippets are informational placeholders; once a one-shot CLI for `distill_journal` exists they can become live commands.

### Removed

- **`journal_append` MCP tool removed.** Superseded by `journal_note` (semantic notes), `journal_intent` (topic pivots), and Layer 1 auto-capture (everything else). The "Journal every Hands tool run" rule in `agent-rules/rules-block.md` is also gone — Hands runs are now captured automatically by L1.

### Changed

- **`rulesVersion` in `packages/core` bumped to `1.3.0`** to force re-injection of the updated rules block on the next `onboard_agent` call. New rules cover `journal.suggested_action` envelope handling, `journal_note` / `journal_intent` usage, and strict-mode `journal_bypass: true` override behavior.
- **MCP tool count: 50 → 52.** README and the in-app `/docs` catalogue updated; `mcp-tools.json` and `mcp-tool-categories.ts` carry full schemas for the new tools.

### Tests

- **+86 new tests** across all three packages covering pattern detectors, distillation pipeline, topic detection, redaction, repository, cooldown lock, presence signal, housekeep, strict-mode, extra-pattern loader, high-water, JSONL writer, migration, capture wrapper, journal-tools smoke, backlog detection, strict-mode integration, scheduler, byte-identity regression.
- **Total suite**: 291 tests passing (233 core / 47 MCP / 11 web), zero regressions.
- **Hands non-regression baseline + byte-identity test** prove that the new Journal panel writes only `journal.*` and never perturbs the `tools.*` slice of `kontexta.json`.

### Notable architectural decisions

- **No "session" concept anywhere in the durable model.** Tasks are *topics*, not sittings. Time gaps within a task are invisible; pauses, breaks, and context switches all just produce the next event in the same task file.
- **L3 (embeddings, graph, semantic clustering) intentionally deferred.** No vector DB until evidence shows FTS5+tags is the bottleneck.
- **Server-side LLM upgrade deferred too.** Mechanical mode is "good enough" (~60% quality); the agent-driven LLM-upgrade path via `distill_journal`'s subagent briefs covers cases where narrative quality matters. Adding server-side LLM later is purely additive — no schema changes required.

## 1.0.0 — Initial kontexta release (Brain + Hands + Eyes)

The first kontexta release after the rename from mnexis. Versioning was reset to `1.0.0` at the rename; this entry summarizes the cumulative behavior shipped under the previous identity (~30 incremental releases) so readers don't need to dig through the pre-rename history.

### Brain — markdown vault + deterministic retrieval

- **Local-first knowledge vault** with two-way git sync. Per-project state lives under `data/projects/<slug>/`; the global KB at `data/knowledge/`. Override locations via `KONTEXTA_DATA_DIR` / `KONTEXTA_DB_PATH`.
- **SQLite + FTS5 indexing** with `porter unicode61` tokenization so technical identifiers, hyphenated filenames, and complex paths search correctly.
- **~50 MCP tools** organized into find / read / write / organize / history / discover / Hands / onboarding categories. Section-level edits (`update_file_section`), batch reads (`read_files` up to 200 IDs), regex + grep, structure ops (folders, moves), tag management, history (`get_history`, `get_diff`, `restore_file`), and metadata-only inspection (`describe_file`).
- **Token-aware responses** — every file-returning tool annotates `est_tokens` and `size_bytes` so agents can budget context.
- **Web clipping** via `clip_url` with auth-wall detection, SSRF protection, and bring-your-own-cookies for authenticated pages.
- **Cross-project semantic discovery** via `find_related` (tag overlap), `whats_new` (delta since timestamp), and `project_map` (compact tree of folders + titles + tags).
- **File watcher** with denylisted noise dirs (`.next`, `.venv`, `dist`, build/cache) and incremental FTS reindex on add/change/unlink.

### Hands — sandboxed command orchestration

- **Per-project `kontexta.json`** declares project-defined commands as namespaced MCP tools (`<project>__<tool>`).
- **Strict sandbox**: realpath-verified CWD, stripped `PATH`, clean env (`PATH`/`HOME`/`USER`/`LANG`/`TZ` only), ring-buffer output cap, hard timeouts, process-group kill on timeout, no shell.
- **Cryptographic confirm tokens** (CSPRNG, single-use, 60s expiry) for high-risk commands. Optional human-approval flow per command.
- **ReDoS-proof parameter validation** via `re2`; default `^[^-].*` mitigates argv injection; opt-in `argSeparator: true` for path-accepting tools.
- **Tools**: `list_hands`, `reload_hands`, `confirm_hand`, `describe_hands_schema` plus the runtime-registered project tools.

### Eyes — feedback loop

- **`whats_new`** — files added/changed since a cutoff. Lets agents catch up at session start without re-reading the whole KB.
- **`diff_against_disk`** + **`refresh_index`** — detect and reconcile drift after out-of-band changes.
- **`journal_append`** — agent-callable timestamped journal under `data/knowledge/journal/YYYY-MM-DD.md` with mandatory logging after every Hands run (rule injected via `onboard_agent`). _(Replaced in 2.0.0 by automatic Layer 1 capture.)_

### Web dashboard

- Three-pane layout (folder tree / file list / content), light/dark theme with warm amber accent.
- In-app `/docs` page with a searchable catalogue of all MCP tools.
- Form-based `kontexta.json` editor for Hands tools with live validation.
- Real-time status bar streaming git activity over WebSockets.
- Favorites, tag management, web clipping UI, ZIP-based KB export, knowledge-base import.
- Animated branding, custom error modals (no browser `alert`), unsaved-edit guard, atomic move/rename.

### Distribution

- **npm package** `kontexta-mcp` with prebuilt `better-sqlite3` binaries for linux/macos/windows × x64/arm64. Install via `npx -y kontexta-mcp` in any MCP client.
- **Docker image** `safiyu/kontexta:latest` for the full web UI; mounts `KONTEXTA_DATA_DIR` for persistence.
- **Glama MCP Registry** — published as `registry.glama.ai/mcp-ntrhtsg0bk:n6ifz00shv`.
- **Tag-driven CI publish** with npm trusted publishing (OIDC, no stored token).

### Agent onboarding

- **`register_project`** detects existing agent context files (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursor/rules/*.mdc` / `.continue/rules/*.md` / `ANTIGRAVITY.md`) and recommends the right onboarding action.
- **`onboard_agent`** writes/updates a fenced, version-stamped kontexta workflow rules block in those files. Idempotent; version bumps splice in place. Supports update mode (existing files) and create mode (scaffolds canonical filenames per agent type).
- **Routing matrix** in the rules block covers all 47 (then 50) MCP tools with when-to-use / when-not-to / suggested alternative columns.

### Security hardening

- **SSRF protection in `clip_url`** — rejects private/loopback/link-local IPv4 (incl. `169.254.169.254`), CGNAT, multicast, private IPv6, and special hostnames. DNS resolution + per-hop redirect re-validation. 10 MiB streaming response cap with `Content-Length` pre-check.
- **`move_file` source containment** — verifies both source and destination paths live under the project/KB base.
- **HTTP response splitting** in download routes — strips CR/LF from filenames, RFC 5987 `filename*` UTF-8 fallback.
- **Symlink-loop safety** in walkers (`refresh_index`, backup sync) via `lstatSync` skipping.
- **FTS index resilience** — defensive `DELETE FROM fts_index WHERE rowid = ?` before INSERT to absorb stale rows from crashed transactions.
- **Credential redaction** — `redactCredentials()` strips `user:pass@` from git error output.

### Reliability

- **Two-way git sync** (not just backup) — pulls and merges remote changes (additions, modifications, deletions) and reindexes locally.
- **`withLock` AsyncLocalStorage-based reentrancy detection** fails loudly instead of deadlocking.
- **Atomic favorite/tag updates**, **race-safe folder fetches**, **journal-append concurrency lock**.
- **WebSocket** clears failed `wss` on EADDRINUSE so next start rebinds.
- **Unsaved-edit guard** prompts before discarding in-progress edits; tab-close warning during unsaved edit.

### Architectural milestones (during the 9.x line)

- **Brain → Hands → Eyes** formalized as the core architectural pattern.
- **Industrialized monorepo** — pnpm workspaces, Turborepo, Docker, dedicated CI workflows for PR / dev / publish.
- **Single source of truth** for versioning via `pnpm version:sync` propagating root → sub-packages → `glama.json`.
- **Comparison table** in README against `CLAUDE.md` / vendor memory / mem0 / Zep with explicit tradeoffs.

### Naming reset

- **Renamed mnexis → kontexta** across packages (`kxta-core`, `kontexta-mcp`, `kxta-web`), env vars (`KONTEXTA_DATA_DIR`), Docker images, and the rules-block markers. Versioning reset to `1.0.0` at the rename; the cumulative pre-rename release history (~30 entries spanning 0.1.0 → 9.5.2) is preserved in git but consolidated into this single summary.
