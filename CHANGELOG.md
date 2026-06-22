# Changelog

## 3.1.1 — Publish template fixes & build repair

### Fixed

- **Mermaid syntax errors rendered after the footer.** Broken diagrams now silently hide their wrapper instead of displaying a large error block with a bomb icon. Added `logLevel: "fatal"` to the mermaid config, error handling in `app.js` to suppress failed renders, and a CSS fallback across all three themes.
- **Web build failure (type error).** `targetAgent` in the onboard API route expected `AgentId` but received a plain `string`. Fixed by importing and casting to `AgentId`.

---

## 3.1.0 — User profile, security hardening, and reliability

### Added

- **User profile system.** A new `knowledge/profile.md` file with required sections (Name, Role, Vision, Roadmap, Preferences, Notes) helps AI agents understand user context. Auto-repaired on creation — missing sections are inserted automatically.
- **`get_profile` MCP tool.** Returns the user profile content, lists missing required sections, and provides setup hints for new users. Agents can call it at session start to understand who they're working with.
- **Profile banner in the web UI.** Surfaces profile status and missing sections directly in the file list, with a first-run wizard to guide new users through setup.
- **Login rate limiting.** The login endpoint now tracks failed attempts per IP (10 attempts, 5-minute lockout) to prevent brute-force attacks.

### Fixed

- **Git environment security hardening.** Additional dangerous environment variables are now stripped before git operations (`GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `GIT_CONFIG_COUNT`) to prevent SSH/command redirection and credential helper injection.
- **Temp/test path detection on Windows.** Path segment matching now uses proper path separators instead of substring matching, avoiding false positives on Windows paths containing "temp" as part of a directory name.
- **Journal meta typing.** Added explicit `RawJournalMetaRow` interface and injectable `now` parameter in `openTasksForProject` for better testability.

### Changed

- **Journal pattern loader improvements.** Enhanced extra-loader and pattern index for more robust journal entry parsing.

---

## 3.0.1 — Stability & reliability fixes

### Fixed

- **Duplicate ID generation in documentation output.** The publish tool now ensures that API endpoints and glossary terms with the same names receive unique HTML IDs instead of causing page collisions.
- **Robust HTML escaping.** Improved sanitization for endpoint data, HTTP methods, and glossary definitions to prevent malformed page structures.
- **API badge sanitization.** The publish tool now restricts endpoint badge values to a set of valid options (`direct`, `remove`, `evolve`), falling back gracefully if invalid values are supplied.
- **Target anchors for interactive blocks.** Added proper HTML `id` attributes to glossary items and API endpoint cards so they can be linked to directly.

---

## 3.0.0 — Documentation publishing & developer experience

### Added

- **Publish module — generate documentation from your knowledge base.** A new `publish` package provides a CLI and pipeline for generating documentation sites, API references, and LLM-readable docs from your kontexta vault. Includes render blocks for endpoints, glossary, mermaid diagrams, navigation, and more.
- **`setDataDir()` export in journal-capture.** Added to allow tests to override the data directory for isolation.
- **`listProjectFoldersWithFiles()` in core.** Lists folders containing `.md`/`.mmd` files for project-aware file discovery.
- **Auto-discover on project registration.** `registerProject()` now returns `{ newlyIndexed: number }` and automatically discovers files on registration.

### Fixed

- **resolveArgv test expectation.** Fixed test that expected empty substituted values to be kept when the code intentionally drops them (matching the test name "drops empty resolved elements").
- **Strict mode awareness.** MCP server now returns `JOURNAL_BACKLOG` error on read tools when undistilled events exist and strict mode is enabled.

### Changed

- **Version bump to 3.0.0.** Major release with new publish module and improved developer experience.

---

## 2.0.10 — Reliability & developer experience improvements

### Fixed

- **WebSocket works on Cloud Workstations and reverse proxies.** The real-time connection for the status bar and file-watcher now shares the same port as the web app. Previously it needed its own port (3001), which is unreachable in many hosting environments. No config changes needed — it just works now.
- **Stray "WebSocket failed" error on page reload.** A one-time flicker on fresh page loads is gone. The connection is now properly torn down when React remounts components, so you'll no longer see a ghost error in the console after refreshing.
- **Dev server sometimes starting on port 3001 instead of 3000.** When you Ctrl-C out of the dev server, the background process could linger and hold port 3000. `pnpm dev:lite` now clears any leftover processes before starting, so it always binds port 3000.
- **Crash ("Module did not self-register") when running `pnpm dev:lite`.** The database driver was being loaded twice by webpack's hot-reload, causing it to fail on startup. Fixed — the dev server now starts cleanly.
- **ReferenceError: require is not defined.** Resolved Tailwind CSS typography import issue when running the dev server under Webpack (`pnpm dev:lite`).

### Added

- **`pnpm dev:lite` — a low-memory dev server.** Recommended for Cloud Workstations, small VMs, or any machine where `pnpm dev` crashes or feels sluggish. Uses less memory (capped at 1.5 GB), takes about the same time to start, and handles cleanup automatically. Run it with `pnpm dev:lite` from the repo root.

### Changed

- **Simpler Docker setup — one port instead of two.** The compose files no longer publish a separate WebSocket port. Only port 3000 needs to be exposed. Existing setups that mapped `3001` can drop that mapping.
- **Faster installs.** Removed 8 unused editor packages and deduplicated the database driver (was installed twice). `pnpm install` is faster and the installed footprint is smaller.
- **Node.js 22 is now the pinned version.** A `.nvmrc` file is included — run `nvm use` in the repo and you're on the right version automatically. This prevents a class of "native module" errors that happen when you switch Node versions mid-project.

---

## 2.0.8 — Login reliability

### Fixed

- **Login errors showed nothing.** If something went wrong during login or first-time setup, the form would silently reset with no feedback. Errors are now surfaced to the user with a clear message.
- **Config generation method updated.** Internal improvement to how config files are generated.

---

## 2.0.7 — Docker health check fix

### Fixed

- **Container marked unhealthy on startup.** The health check endpoint was requiring authentication even for localhost requests inside the container, causing Docker to think the app was down. Fixed — health checks from inside the container now work without a session.

---

## 2.0.6 — Glama MCP registry

### Added

- **Listed on Glama.** Kontexta is now discoverable on [Glama's MCP registry](https://glama.ai) with live status badges in the README and MCP manifest.

---

## 2.0.5 — Docker improvements & auth fixes

### Added

- **Configurable Docker setup via environment variables.** No more editing compose files directly:
  - `HOST_PORT` — which port to expose the web UI on
  - `DATA_DIR` — where to store your vault on the host
  - `PROJECT_DIR` — which folder on your machine to mount as projects (required)
- **Two Docker modes:** `docker-compose.yml` for building from source, `docker-compose.hub.yml` for pulling the pre-built image.

### Fixed

- **Login broken behind a reverse proxy (HTTP).** Sessions weren't sticking when the app was served over plain HTTP behind a proxy. Fixed.
- **First-run setup got stuck in a loop.** The setup page now loads on demand instead of being pre-built, so you can complete initial configuration without restarting the container.
- **Database setup failed in some Docker environments.** Auth migrations now always run on startup.

### Changed

- **`PROJECT_DIR` is required.** The container checks for it on startup and gives a clear error if missing, rather than silently misconfiguring paths.

---

## 2.0.4 — GitHub Copilot support

### Added

- **GitHub Copilot is now a supported agent.** Kontexta can onboard Copilot by scaffolding `.github/copilot-instructions.md` with the workflow rules block. No MCP config needed for Copilot — it's file-based.

---

## 2.0.3 — Stability & test suite

### Fixed

- **Several internal tests were broken** after UI and template changes. All 104 web tests are now passing, along with the full core and MCP suites.
- **`comprehensive-example` Hands template** had an invalid command format. Fixed.

---

## 2.0.2 — Journal data safety

### Fixed

- **Raw journal events could be deleted before being processed.** If housekeeping ran aggressively while distillation was stalled, unprocessed events could be permanently lost. Housekeeping now refuses to delete any log file that contains events newer than the last distillation checkpoint.

---

## 2.0.1 — Clean shutdown

### Fixed

- **In-progress work could be cut short on shutdown.** When the MCP server received a stop signal (Ctrl-C, Docker stop, etc.), it would exit immediately and potentially truncate an in-flight file write or database operation. The server now waits up to 10 seconds for any active work to complete before exiting.

---

## 2.0.0 — Journaling: persistent memory across sessions

The biggest release since launch. Kontexta now maintains a persistent, auto-updating journal of everything your agents do — automatically, with no changes to your workflow.

### What's new

- **Automatic session capture.** Every MCP tool call is silently recorded to a per-project event log. Nothing to configure, nothing to remember to call. Survives crashes and power loss.
- **Automatic distillation.** Raw events are periodically condensed into structured markdown summaries, organized by task or topic, and indexed alongside your knowledge base so agents can search them.
- **10 built-in activity patterns** are detected automatically: feature development, refactor, test cycles, error recovery, incident response, exploration, and more.
- **Voluntary annotations.** Agents can call `journal_note(text)` or `journal_intent(summary)` to mark decisions, pivots, or context worth preserving.
- **Git-aware.** Branch changes and new commits are captured automatically, with ticket IDs (e.g. `PROJ-123`) extracted and indexed for cross-referencing.
- **Journal panel in the dashboard.** Configure retention, distillation mode, and scheduling. View open tasks and live distillation status.
- **Enforcement modes.** `lenient` (default) — nudges agents when a backlog builds up. `strict` — blocks read tools until the backlog is distilled. `mechanical-only` — distillation runs in-process, no LLM involved.
- **Housekeeping tool.** `housekeep_journal` prunes old raw logs and archives cold tasks according to your retention settings.
- **Background scheduler.** When the dashboard is running, distillation runs every 15 minutes and housekeeping every 24 hours, deferring automatically when the MCP server is active.

### Removed

- **`journal_append` tool removed.** Replaced by automatic Layer 1 capture and the new `journal_note` / `journal_intent` tools. The manual journaling rule in agent context files is also gone — it's all automatic now.

### Updated

- Agent rules block bumped to `1.3.0` — re-run `onboard_agent` on your projects to get the updated guidance.
- MCP tool count: 50 → 52 (two new journal tools).

---

## 1.0.0 — Initial release (Brain + Hands + Eyes)

The first public release of Kontexta following the rename from mnexis. This entry summarizes everything shipped across ~30 pre-rename releases.

### Brain — knowledge vault

- Local markdown vault with two-way git sync.
- SQLite full-text search with stemming (`porter unicode61`) — searches titles and content across all your files.
- ~50 MCP tools covering read, write, search, organize, tag, history, and discovery.
- Every tool response includes a token estimate so agents can budget context.
- Web clipping via `clip_url` with auth-wall detection and SSRF protection.

### Hands — sandboxed commands

- Per-project `kontexta.json` registers shell commands as MCP tools.
- Strict sandbox: verified working directory, stripped environment, hard timeouts, no shell execution.
- Cryptographic confirmation tokens for high-risk commands.
- ReDoS-proof parameter validation.

### Eyes — feedback loop

- `whats_new` — catch up on what changed since your last session.
- `diff_against_disk` + `refresh_index` — detect and reconcile out-of-band changes.
- `journal_append` — manual session journaling (replaced by auto-capture in 2.0.0).

### Dashboard

- Three-pane layout (folders / files / content), light/dark theme.
- In-app tool catalogue at `/docs` with search.
- Visual `kontexta.json` editor with live validation.
- Real-time git sync status via WebSockets.
- Favorites, tags, web clipping, ZIP export, KB import.

### Distribution

- `npx -y kontexta-mcp` — zero-install MCP server with prebuilt binaries for Linux/macOS/Windows.
- `safiyu/kontexta:latest` — Docker image for the full dashboard.
- Listed on [Glama MCP Registry](https://glama.ai).

### Security

- SSRF protection blocks private/loopback IPs, cloud metadata endpoints, and redirect chains.
- Path containment checks on all file operations.
- Credential redaction strips secrets from git error output.
- Symlink-safe directory walkers.

### Naming

Renamed from **mnexis** → **kontexta**. Versioning reset to `1.0.0`. Pre-rename history (~30 releases, 0.1.0 → 9.5.2) is preserved in git.
