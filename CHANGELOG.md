# Changelog

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
