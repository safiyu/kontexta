# Changelog

## 4.6.0 — Your agent starts every session already knowing you

This release turns Kontexta into a workspace the agent walks into fully briefed. Your profile, your calendar, your rules, your team — surfaced once at session start, honored throughout, and mirrored in the dashboard so you and the agent see the same picture.

### The agent shows up prepared

- **A one-shot briefing at session start.** Every time you open an AI client, Kontexta hands it a summary: today's date, your profile, the next week's calendar, any conflicts, and a nudge if your profile is out of date. You don't have to remind it who you are or what you're working on.
- **A profile that captures the parts that don't fit in code.** The user profile now has eight sections instead of six — the two new ones are **Session coding style** (your hard rules: comment style, git etiquette, review gates) and **Team members and roles** (so the agent names people correctly in summaries). Existing profiles auto-gain the new sections, empty and ready to fill.
- **Ask for a refresh anytime.** A new `refresh_session_context` tool re-reads your profile and re-checks the calendar mid-session — for when you've just edited your notes and want the agent to catch up.

### A dashboard you can live in

- **A daily briefing on the home screen.** Open Kontexta with no file selected and you land on a greeting card: "Good morning, Safiyu" with the date, upcoming events, any conflicts front and center, and a profile nudge if things are stale.
- **A real profile page.** Click `profile.md` and you get a structured editor with per-section fields, a completeness meter, and a hero avatar showing your name and role — instead of a raw markdown blob. Raw-mode toggle for power users.
- **"Referenced by" on every note.** When you open a note, a panel at the bottom shows every other file that mentions it, with a preview snippet and click-to-jump. Discovery without a search bar.
- **Tag browser in the sidebar.** All your tags with file counts, sorted by count, searchable. Click one to filter the file list.
- **A calmer folder tree.** The four knowledge buckets (Journal, Knowledge, Mermaid, HTML) always show at the top with their own icons — even empty. Hover a bucket for a `+` button that adds a subfolder inside it.
- **Blueprint theme is the new default** for fresh installs. Existing users keep whatever theme they picked.

### A knowledge base with a shape

- **The knowledge base now has a predictable layout.** Everything you save lives under one of four folders — `journal/`, `knowledge/`, `mermaid/`, or `html/` — plus a single `profile.md` at the root. Each folder holds one kind of file (markdown, mermaid, HTML) so the agent and the dashboard always know what to do with what's there. Media for HTML reports goes in `html/resources/`.
- **Bring your existing vault along.** A migration script (`scripts/migrate-kb-layout.mjs`) surveys an existing knowledge base, shows you what would move where in a dry run, and applies the changes on demand. Files that are already indexed move safely (paths and search index stay in sync).
- **Existing off-spec files still work.** They stay readable, editable, and deletable — you can migrate on your own schedule. Only new writes need to follow the layout.

### Smaller polish, big daily wins

- **Uploading media just works.** Drop a `.png` or `.pdf` into `html/resources/` from the upload dialog — no more `unsupported extension` rejections.
- **The upload dialog on a fresh install** gives you a text input with bucket suggestions when no subfolders exist yet, instead of a locked dropdown.
- **In-place rename inside legacy folders** stays allowed, so you can tidy up without being forced to move everything at once.
- **Profile edits are safer.** The editor no longer wipes what you're typing if something refreshes in the background.
- **Cleaner error messages.** Layout mistakes on file moves surface as clear "wrong destination" errors instead of generic server crashes.
- **`DELETE /api/folders` refuses to wipe a whole bucket by name** — a stray `?name=journal` used to erase every journal entry. Not anymore.

### Fixed

- Duplicate uploads on Windows could silently overwrite each other in certain folders — folder matching now works on both slash conventions.
- The MCP `list_folders` response now uses the same path shape as the dashboard's folders API, so tools keying off folder names see one consistent value.

### Breaking

- **New writes must fit the layout.** Uploads, `create_file`, `create_files`, `create_folder`, and `move_file` all reject destinations outside the four-bucket structure. If your scripts write to `<dataDir>/knowledge/` directly, pick one of `journal`, `knowledge`, `mermaid`, or `html`.

## 4.5.2 — Default port moved to 23002

### Changed

- **Default dashboard port is now 23002** (was 3000) across `kontexta start`, `pnpm dev`, and Docker, to avoid collisions. `PORT` / `HOST_PORT` overrides still win.

## 4.5.1 — Hermes Agent in the Configure section

### Added

- **Hermes Agent client in the dashboard's Configure section.** Pick "Hermes Agent" to get a ready-to-paste `mcp_servers` YAML block for `~/.hermes/config.yaml`.

## 4.5.0 — HTML reports in the knowledge base

### Added

- **HTML reports as first-class KB entries.** Save an analysis as HTML with linked images, view it in the dashboard (sandboxed), and export it as PDF or PNG. A new `reports/` folder holds the reports themselves; a shared `reports/resources/` folder holds their images (served at `/api/reports/resources/<name>`).
- **New MCP tools:** `create_file` / `update_file` accept `format="html"`; `add_report_resource`, `list_report_resources`, `delete_report_resource` manage the shared resource pool; `export_report` returns a download URL (or inline bytes) for PDF/PNG.
- **Published pages appear in the knowledge base.** After each publish, generated `index.html` / `llms.txt` are indexed under `publish/` and browsable through the normal file list. They're read-only in the UI (regenerated on the next publish).

### Changed

- **PDF export for HTML reports uses headless Chromium.** Real CSS layout, real images, real fonts. Chromium is downloaded lazily on first export into `~/.cache/kontexta/chromium/`, so `npx kontexta start` install time is unchanged. `kontexta doctor` reports whether it's installed.

## 4.4.2 — PDF export renders arrows, check marks, and code

### Fixed

- **PDF export no longer drops characters like `→`, `←`, `↑`, `↓`, `⇒`, `✓`, and `✗`.** pdfmake's bundled Roboto TTFs omit those glyphs, so they silently rendered as blank space in exported PDFs. Switched the PDF renderer to DejaVu Sans (full BMP coverage — arrows, math, checkmarks, extended Latin/Greek/Cyrillic).
- **Fenced code blocks in exported PDFs are now monospaced.** They previously inherited the proportional document font, so indented lines and aligned characters didn't line up. Code and `<pre>` blocks now use DejaVu Sans Mono.

## 4.4.1 — Clickjacking-safe dashboard

### Fixed

- **Dashboard responses now set `X-Frame-Options: DENY` and `frame-ancestors 'none'`**, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Prevents a hostile site the user visits in the same browser from iframing `http://localhost:<port>` and clickjacking into destructive dashboard actions.

## 4.4.0 — Update in one command, and know when you should

### Added

- **`./update` and `update.ps1`** for source/manual installs: safety-checks a clean working tree, fast-forward pulls, re-runs bootstrap, and rebuilds the whole workspace in one step.
- **New-version notice in the dashboard.** The status bar checks the npm registry for the latest `kontexta` release and shows an "update available" link (opens Configure) when you're behind — works regardless of install method, since the comparison is always against the published package version.
- **Configure's manual-install entrypoint is now detection-based**, not guessed: `./bootstrap` writes a flag with the real `apps/mcp/dist/index.js` path, so the Source-build snippet always points at your actual checkout instead of a frozen build-output copy. Shows a clear message when no bootstrapped checkout is found.
- **Configure's npm snippet detects a local `kontexta` CLI install** (from `npx kontexta start`) and prefers `npx kontexta mcp` — the same server, already fetched — falling back to the standalone `kontexta-mcp` package otherwise. Either way, the alternative is noted.

## 4.3.2 — Config snippets know how you were installed

### Fixed

- **Client config snippets from an npx-installed dashboard now use `npx`.** The dashboard previously mis-detected a `npx kontexta start` install as a source build and pointed MCP client configs at a file inside the npx cache — a path that breaks whenever npx evicts it. The CLI now tells the dashboard how it was installed, so `/docs` emits the durable `npx -y kontexta-mcp` config instead.

## 4.3.1 — One command, and Kontexta is running

Installing Kontexta no longer requires Docker, pnpm, or a build step. If you have Node 22, you have Kontexta.

### Added

- **`npx kontexta start` — the new one-click install.** One cross-platform command boots the full dashboard and MCP server, picks a free port, and opens your browser. First-run setup (master password, data location, projects) happens in the browser. Also ships `kontexta mcp` (stdio MCP server for your AI client config) and `kontexta doctor` (environment diagnostics: Node version, data directory, native-module health).
- **Contributor bootstrap in one step.** `./bootstrap` (macOS/Linux) and `bootstrap.ps1` (Windows) check your Node version, activate the pinned pnpm via corepack, probe for a C/C++ toolchain, install dependencies, and build the core — then tell you exactly what to run next.
- **Per-OS CI smoke tests.** Every change to the CLI is verified on Ubuntu, macOS, and Windows: the published tarball is installed fresh, the dashboard boots and passes its health check, and the MCP server completes a real handshake — all without a compiler on the machine.
- **Optional shared vault for Docker.** The compose file now documents a same-path mount so the container can share the exact vault used by `npx kontexta` and local dev — with a clear warning about never running both against it at once.

### Changed

- **README and install docs lead with `npx kontexta start`.** Docker remains a first-class alternative; the source build is now framed as the contributor path (`./bootstrap && pnpm dev`).
- **Installing via npm no longer requires pnpm on your machine.** `apps/mcp` dropped its `postinstall: pnpm rebuild re2` hook; native modules load from prebuilt binaries matched to your OS and Node version.

### Fixed

- **`npm install kontexta-mcp` works again.** The published package carried an unresolvable internal `workspace:*` dependency, so installing it outside the monorepo failed with `EUNSUPPORTEDPROTOCOL`. The internal core is now compiled into the published build and its runtime dependencies are declared properly — verified end-to-end by CI on every release.
- **One vault everywhere, including Windows.** The new CLI now resolves the default data directory identically to the server core on every platform (`%APPDATA%\kontexta` on Windows), so `npx kontexta start` and `npx kontexta-mcp` always read and write the same vault.

## 4.2.0 — Export any file as Markdown, Text, or PDF

You can now save any file straight from the viewer, in whatever format suits you.

### Added

- **Export button in the file viewer.** Open any file and download it as a plain Markdown file, a clean plain-text file (no `#`, `**`, or other markdown symbols cluttering it up — code snippets and tables are kept intact), or a ready-to-share PDF, all with one click.

### Improved

- **Every action now tells you what happened.** Creating, deleting, saving, syncing, and publishing all show a clear confirmation or error message on screen — no more silent failures, and no more jarring browser pop-ups for confirmations.
- **Dialogs and menus across the app are more consistent and keyboard-friendly.** Escape closes them, clicking outside dismisses them, the same way everywhere.
- **The calendar page has a close button** and its toolbar no longer crowds or overlaps when the Conflicts panel is open.
- **Light mode is easier on the eyes.** Fixed several spots — the file browser, search results, and calendar event colors — where text could become hard to read against the light background.

### Fixed

- **A startup warning about a missing search component** that showed up in some setups. It's now installed correctly every time, automatically.
- **Clicking a scheduling conflict in the calendar now actually jumps you to it**, in Month and Week view, not just Agenda view.
- **The calendar's conflict-buffer setting now always shows the value you actually saved**, instead of a stale default.
- **The file search box could disappear while still filtering**, making a folder look empty for no obvious reason. Fixed.
- **A failed "New file" or "New folder" no longer discards what you typed.** You can fix the problem and try again without retyping.
- **Fixed a brief flash of the wrong layout** on tablets and phones right after the page loads.
- **Fixed dialogs and menus occasionally flashing in the wrong spot** before settling into place.

## 4.1.0 — Journal notes now write themselves, everywhere

Kontexta's journal turns your day-to-day work into readable notes automatically — but until now, only for projects it already knew about. Work done anywhere else (your home folder, a quick script, a repo you hadn't registered yet) just piled up as raw activity, waiting.

### Added

- **Journal notes now generate everywhere, automatically.** A background process periodically turns accumulated activity into readable notes for every project it sees — including folders you haven't formally registered yet. That work lands in a shared "unregistered work" bucket so nothing is lost while you decide whether to register the project properly.
- **Register a project later without losing its history.** If you eventually register a project that already has notes sitting in the shared bucket, Kontexta links your existing notes to the new project instead of starting over.
- **Fewer unnecessary reminders.** Kontexta now only nudges you to catch up the journal when there's a meaningful backlog, not after every single action.

### Fixed

- **Some journal activity from unregistered folders was silently never turned into notes.** It just accumulated forever without anyone noticing. It's now caught and processed automatically.
- **A rare timing gap could permanently skip a few journal entries** written right as notes were being generated for that same project. Fixed.

## 4.0.0 — Calendar: schedule anything, catch conflicts automatically

A brand new module for scheduling and tracking events across whatever you manage — servers, delivery vehicles, store locations, equipment, rooms, anything you name. Works both through chat and as a full visual calendar in the dashboard.

### Added

- **Calendar module.** Add "entities" for anything you want to schedule against — a server, a vehicle, a location, a piece of equipment — draw dependency links between them, and log one-off events like downtime, maintenance, deliveries, or shifts.
- **Automatic conflict detection.** Kontexta flags overlapping events on the same entity, overlapping events on linked entities, and events scheduled too close together — with a configurable minimum buffer — so scheduling clashes get caught before they happen.
- **A full Calendar page in the dashboard.** Month, week, and agenda views in the same look and feel as the rest of the app. Add and edit events with a click, manage your entities and their dependencies, and see conflicts highlighted as you plan.
- **Export to your everyday calendar.** Download any date range as a standard calendar file to import into Outlook, Google Calendar, or Apple Calendar.
- **New chat tools for calendar management,** so an agent can add an event straight from a pasted email, check what's scheduled this week, or flag conflicts — no need to open the dashboard.

### Updated

- Agent rules guidance refreshed to cover the new calendar tools — re-run the onboarding step on your projects to pick it up.

## 3.3.0 — Publish theme expansion & journal auto-slug

### Added

- **Six new publish themes.** Choose from `flat`, `terminal`, `paper`, `solarized`, `brutalist`, and `ocean` in addition to the original three, each with a live preview in the publish dialog.
- **Custom tagline for published sites.** Add an optional subtitle under your site's hero title.
- **Option to hide the hero section** when publishing a site, if you'd rather start straight with content.
- **"Last built" indicator.** The publish dialog now shows how long ago your site was generated and how big it is.
- **Smarter project detection in the journal.** Kontexta now figures out which project you're working in automatically in more cases, instead of falling back to a generic bucket.

### Changed

- **Faster first-time setup.** Installing dependencies now compiles the database driver automatically, so there's no separate rebuild step after cloning the repo.

## 3.2.2

### Fixed

- **MCP server could crash on startup in some environments.** A missing dependency caused failures on certain CI/CD and other strict setups. Fixed.

## 3.2.1

### Fixed

- **Docker builds could fail on some platforms.** Native components now always compile correctly for the target platform during a Docker build.
- **Docker build could fail before a database existed yet.** Build steps that don't need a live database now skip that requirement.
- **The publish tool sometimes showed the wrong version number.** It now always reflects the actual installed version.
- **MCP server could hit import errors at startup.** Fixed a bundling issue affecting certain Node.js built-ins.

## 3.2.0 — Security hardening, journal reliability, and publish resilience

### Added

- **One-click reindex in the dashboard.** Refresh the search index across every project and your knowledge base at once; only one refresh runs at a time.
- **More reliable journal housekeeping.** Coordination across multiple running processes now happens through the database itself, preventing rare race conditions.
- **Safer handling of requests behind a proxy.** Rate limiting can now correctly identify real visitor addresses behind a trusted proxy, without being spoofable by default.
- **Stronger file-path safety checks** across the app, guarding against symlink tricks and access to sensitive system folders.
- **Bigger search results on request,** for when you need more than the default 50 matches in one go.

### Fixed

- **Logging out could be triggered from another site.** Closed this cross-site request vulnerability.
- **Old session tokens no longer expired.** Sessions now correctly time out after 30 days.
- **Publish pages were reachable without logging in.** Now require authentication.
- **A path-traversal weakness in project registration and publishing.** Fixed with stricter checks.
- **Exporting files as a ZIP could include files outside the intended scope.** Fixed.
- **A rare timing issue when editing project settings** could let a missing file go undetected. Fixed.
- **Occasional lost or duplicated journal entries** when two things happened in the exact same instant. Fixed.
- **Journal entries could lose their original start date** when re-summarized. Fixed.
- **Archiving old journal files could fail when moving across drives.** Now falls back to a copy instead of erroring.
- **A rare crash right after the journal shut down.** Now handled gracefully.
- **Ambiguous timestamps were silently misinterpreted.** A timestamp with no timezone is now rejected with a clear error instead of being guessed.
- **One broken document could stop an entire publish run.** It's now skipped with a warning instead.
- **Broken navigation for nested folders when publishing.** Fixed.
- **Duplicate page elements when publishing docs with matching names.** Now kept unique.
- **Broken links for folders with special characters when publishing.** Fixed.
- **Rough edges in the publish dialog.** The folder is now auto-selected, and a successful publish closes the dialog with a clear confirmation instead of updating silently.
- **Switching files quickly could briefly show stale content.** Fixed.
- **The project list could occasionally show outdated data after fast changes.** Fixed.

### Changed

- **Sturdier startup and build scripts,** reducing the chance of partial failures.
- **Test and lint runs no longer get cached incorrectly.**

---

## 3.1.1 — Publish template fixes & build repair

### Fixed

- **Broken diagrams showed an ugly error block.** Invalid diagrams are now hidden gracefully instead of displaying a large error message.
- **A build failure was blocking releases.** Fixed a type mismatch in the onboarding setup.

---

## 3.1.0 — User profile, security hardening, and reliability

### Added

- **User profile.** Kontexta can now store a short profile about you — name, role, goals, and preferences — so agents understand your context from the start. Missing sections are filled in automatically.
- **A tool for agents to read your profile,** so they can check it at the start of a session.
- **Profile prompts in the dashboard,** with a first-run wizard to help new users fill theirs in.
- **Login rate limiting.** Repeated failed login attempts from the same address are now temporarily locked out to block brute-force attempts.

### Fixed

- **Stronger protection against credential and command injection during git operations.**
- **A Windows-specific bug** that could misidentify normal folders as temporary or test paths.
- **Small reliability improvements to journal task tracking.**

### Changed

- **More robust journal entry parsing.**

---

## 3.0.1 — Stability & reliability fixes

### Fixed

- **Duplicate page elements in published docs** when two items shared the same name. Fixed.
- **Stronger protection against malformed content** breaking published pages.
- **Invalid values in API documentation badges** are now handled gracefully instead of breaking the page.
- **Glossary and API entries can now be linked to directly** with their own web addresses.

---

## 3.0.0 — Documentation publishing & developer experience

### Added

- **Publish your knowledge base as a documentation site.** A brand new publishing tool turns your vault into a browsable site, complete with API references, a glossary, and diagrams.
- **Projects now scan for files automatically the moment you register them,** instead of requiring a manual step.

### Fixed

- **Minor internal test and strict-mode reliability fixes.**

### Changed

- **Version bump to 3.0.0** for this major release.

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
