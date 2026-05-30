# Design: `kontexta-mcp init` CLI

**Status:** Draft for review
**Date:** 2026-05-18
**Author:** Brainstormed with Safiyu
**Scope:** First-run onboarding experience for terminal-installed users (the `npx kontexta-mcp` flow). The web UI's existing Configure modal handles dashboard users and is out of scope.

---

## 1. Motivation

A brand-new user who runs `npx kontexta-mcp` today has no guided path from "package installed" to "Claude Code is using kontexta with my first project registered." They need to:

1. Know that a data directory was created (or know to set `KONTEXTA_DATA_DIR`)
2. Register their first project (currently only doable via the `register_project` MCP tool, which requires an MCP-aware agent to already be configured — chicken/egg)
3. Hand-edit their MCP client's config file using a snippet they find in the dashboard docs

Drop-off after install is the most expensive moment in a developer tool's adoption funnel. This spec defines an `init` subcommand that compresses the above into a single guided flow.

## 2. Non-Goals

- **Replacing the web UI's Configure modal.** The dashboard already shows install snippets; that flow stays as-is.
- **Building a full configuration management layer.** `init` runs once (or rarely) per user; it is not a daemon and does not own config files long-term.
- **Auto-installing or auto-launching the dashboard.** Init prints a hint pointing at `docker compose up -d`; it does not run Docker.
- **Auto-registering multiple projects.** Init handles the *first* project. Subsequent projects use the existing `register_project` MCP tool.
- **Solving project discovery.** No directory scanning, no "we found 5 git repos in your home folder." The user explicitly provides one path.

## 3. Command Surface

A single new subcommand added to the `kontexta-mcp` binary:

```
npx kontexta-mcp init [options]
```

### Flags

| Flag | Purpose |
|---|---|
| `--project <path>` | Register this path as the first project; skip the prompt. |
| `--no-project` | Skip first-project registration entirely. |
| `--clients <list>` | Comma-separated client IDs (e.g., `claude-code,cursor`); skip the picker. |
| `--no-clients` | Skip client config entirely. |
| `--data-dir <path>` | Override `KONTEXTA_DATA_DIR` for this init. |
| `--yes` / `-y` | Accept all defaults; fail if required info missing. |

### TTY behavior

- **TTY + no `--yes`**: full interactive flow with prompts.
- **TTY + `--yes`**: silent. Uses defaults: data dir from env/OS, project skipped unless `--project` given, all *detected* auto-write clients configured unless `--no-clients` or `--clients` narrows the set.
- **Non-TTY + no `--yes`**: exit 3 with a clear error explaining to use `--yes` plus flags. **Never hang waiting for input in CI.**
- **Non-TTY + `--yes`**: same as TTY + `--yes`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Full success |
| 1 | User cancelled (Ctrl-C or "no" at a confirmation) |
| 2 | Partial success — at least one client failed to auto-write, snippets printed as fallback |
| 3 | Fatal error — data dir / DB init failed, or required flag missing in non-TTY mode |

## 4. Init Flow Phases

Five phases. Each runs independently and reports its own success/failure. Failure of one phase does not necessarily abort the others (e.g., a failing client write does not roll back project registration).

### Phase 1: Data dir setup

- Resolve target: `--data-dir` → `$KONTEXTA_DATA_DIR` → OS default (already in `packages/core/src/paths.ts`).
- Create the directory if missing.
- Initialize the SQLite DB via existing core init function.
- Print: `✓ Data directory ready: <path>`.

**Failure mode:** filesystem permission errors → exit 3 with the OS error message and a hint to set `KONTEXTA_DATA_DIR` to a writable location.

### Phase 2: First project registration

- Default path candidate: `process.cwd()` if it looks like a git repo (`.git/` exists), else empty.
- Prompt: `Path to your first project? [<default> / press enter to skip]`.
- If `--project <path>` was passed, use it without prompting.
- If `--no-project` was passed, skip the phase.
- Validate the path exists and is a directory; reject otherwise with a re-prompt (or error in `--yes` mode).
- Call existing core `register_project` function with the path. Project name defaults to the directory basename.
- Print: `✓ Registered project: <name> at <path>`.

**Failure mode:** invalid path → re-prompt up to 3 times, then skip with a warning. Already-registered path → treat as success, print "already registered."

### Phase 3: MCP client detection

Probe filesystem for known client config locations (per OS). Build a list of all 8 supported clients (Claude Code, Claude Desktop, Cursor, Codex, Gemini, Antigravity, Continue, Aider) with three status flags each:

- **detected**: config file/binary exists
- **strategy**: one of `auto-cli`, `auto-file-write`, `auto-json-merge`, `auto-yaml-merge`, `copy-paste`
- **enabled-by-default**: true if `detected` AND strategy ≠ `copy-paste`

Display checklist:

```
Detected MCP clients — pick which to configure:
 [x] Claude Code      (claude mcp add)
 [x] Cursor           (~/.cursor/mcp.json)
 [x] Continue         (~/.continue/mcpServers/kontexta.yaml)
 [ ] Codex            (copy-paste — TOML format)
 [ ] Antigravity      (not detected; --clients antigravity to force)
 [ ] Gemini           (copy-paste)
 [ ] Aider            (copy-paste — not native MCP)
```

If `--clients <list>` was passed, skip the picker and use the explicit list. Unknown client IDs cause exit 3 with the list of valid IDs printed.

### Phase 4: Apply config to selected clients

For each chosen client, run its per-client strategy. See Section 5 for the strategy table.

Each result reported individually:

- `✓ <client> configured` — auto-write succeeded
- `⚠ <client>: <reason>; snippet printed instead` — fell back to copy-paste due to runtime issue (e.g., `claude` CLI not on PATH, config file malformed, write permission denied)
- `📋 <client> requires manual paste — see snippet above`

Continue on per-client failure. Aggregate outcomes determine the final exit code (2 if any client failed to auto-write).

**Backup before write:** before modifying any existing file, write a sibling `<filename>.kontexta-bak-<timestamp>` so the user can restore manually. Backups are not auto-cleaned.

### Phase 5: Hint

Print final summary:

```
Setup complete. Try it:
  • Open Claude Code, then type: /mcp
  • Optional dashboard: docker compose up -d  (then http://localhost:3000)
  • Docs: https://github.com/safiyu/kontexta#readme
```

## 5. Per-Client Strategy Matrix

| Client | Strategy | Mechanism | Risk |
|---|---|---|---|
| Claude Code | `auto-cli` | Shell out to `claude mcp add kxta -s user -e KONTEXTA_DATA_DIR=<dir> -- npx -y kontexta-mcp`. Detect by checking `claude --version` exits 0. Fall back to copy-paste if `claude` is missing or the `mcp add` syntax errors. | Low — Anthropic owns the CLI; if syntax changes, fallback kicks in. |
| Cursor | `auto-json-merge` | Read `~/.cursor/mcp.json` (or create), JSON parse, set `mcpServers.kxta`, write back. | Low — well-known format. |
| Continue | `auto-file-write` | Create `~/.continue/mcpServers/kontexta.yaml` (standalone file, no merge needed). Skip if file exists unless `--force`. | Low — no merge. |
| Claude Desktop | `auto-json-merge` | Same as Cursor but with OS-specific path: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json`. | Low — well-known format. |
| Antigravity | `auto-json-merge` | Same JSON merge pattern; path TBD-verified against current Antigravity docs before ship. | Medium — newer client, path may be unstable. |
| Codex | `copy-paste` | Print snippet + path `~/.codex/config.toml`. TOML merge not attempted. | N/A (no write). |
| Gemini | `copy-paste` | Print snippet + path `~/.gemini/settings.json`. JSON technically mergeable, but path/schema needs verification — defer auto-write to v1.1. | N/A (no write). |
| Aider | `copy-paste` | Not native MCP. Print snippet for `.aider.conf.yml`. | N/A. |

### Path verification requirement

Before ship, every path in the table above must be re-verified against the current (2026) docs of each client. The web UI's `install-templates.ts` has known-stale paths (Gemini, Codex) — do not blindly reuse them.

## 6. Re-run / Idempotency Behavior

`init` is safe to re-run. Per phase:

- **Data dir:** no-op if already initialized.
- **Project:** if path is already registered, print "already registered" and continue.
- **Clients:** if the kontexta entry is already present in a config file (same `command` + `args`), skip and report `✓ <client> already configured`. If a different `kxta` entry exists, prompt: `Overwrite existing kxta entry in <file>? [y/N]`. In `--yes` mode, never overwrite; report `⚠ skipped to avoid clobbering existing entry`.

## 7. Architecture & File Layout

New files in `apps/mcp/src/init/`:

```
apps/mcp/src/init/
├── index.ts              # entry point invoked by the main CLI router
├── flow.ts               # the 5-phase orchestrator
├── prompts.ts            # interactive prompt wrappers (TTY-aware)
├── args.ts               # flag parsing
├── detect.ts             # client detection per OS
├── writers/
│   ├── index.ts          # strategy dispatch
│   ├── claude-code.ts    # auto-cli
│   ├── json-merge.ts     # shared helper for Cursor / Claude Desktop / Antigravity
│   ├── continue.ts       # auto-file-write
│   └── copy-paste.ts     # snippet printer
├── snippets.ts           # thin wrapper that imports install-templates from packages/core (see §8)
└── types.ts              # ClientId, Strategy, PhaseResult types
```

**Existing `apps/mcp/src/index.ts`** gains a top-level command router: if `argv[2] === "init"`, dispatch to `init/index.ts`; otherwise current MCP server startup.

### Shared logic

The `install-templates.ts` module currently lives in `apps/web/src/lib/`. To share with the CLI, **move it to `packages/core/src/install-templates.ts`** and re-export from both apps. This is the only refactor required outside the new init directory.

### Boundaries

- `init/` knows about the filesystem, prompts, and the user.
- `writers/` know only about a single client each — given a snippet and a config path, write it.
- `detect.ts` is pure: given `process.platform` and `process.env`, return a list of `ClientStatus`. Easy to test with mocked input.
- `flow.ts` orchestrates but contains no I/O of its own — every effect is delegated.

## 8. Dependencies

| Dep | Size | Purpose | Alternative |
|---|---|---|---|
| `@clack/prompts` | ~50 KB | TTY-aware prompts (select, confirm, text) | Roll a 100-line readline wrapper (no dep, more code) |
| (none for args) | — | A 50-line custom parser suffices for ~6 flags | `commander` (~30 KB) if surface grows |

**Decision:** add `@clack/prompts`. Skip an arg-parsing dep.

## 9. Testing Strategy

- **Unit tests** for each writer with mocked filesystem (`memfs` or vitest's built-in fs mocks).
- **Unit tests** for `detect.ts` with mocked `process.platform` + injected fs probes.
- **Integration test**: spawn `kontexta-mcp init --yes --no-clients --project /tmp/test-repo` against a temp data dir; assert DB row created and project registered.
- **Snapshot test** for the printed snippet output per client.
- No E2E test that actually writes to real client config files — too platform-dependent.

## 10. Cross-Platform Notes

- **macOS / Linux**: primary targets. All paths use `os.homedir()` + `path.join`.
- **Windows**: best-effort. `%APPDATA%` resolution via `process.env.APPDATA`. Document in README as "tested on macOS/Linux; Windows feedback welcome." File-locking edge cases (e.g., Claude Desktop holding its config file open) may cause writes to fail — fall back to copy-paste as designed.

## 11. Risks & Open Questions

1. **Path correctness** (Section 5). Wrong path = silent failure for that client. Mitigated by verification before ship + the per-client outcome report.
2. **Claude Code CLI dependency.** If `claude` CLI is not on PATH (older installs, IDE-only users), the easiest auto-write path becomes copy-paste. Acceptable; documented in the strategy table.
3. **JSON-with-comments.** Some clients (notably VS Code variants) allow JSONC. `JSON.parse` strips comments. **Decision:** assume strict JSON; document caveat in the writer; if a parse error occurs, abort that client write and copy-paste fallback.
4. **Concurrent edits.** If the user's MCP client is running and rewrites its config file between our read and write, we lose. Acceptable for v1 — backup file is the recovery path.
5. **Should `init` also offer to enable journal strict mode / set the master password?** **Decision:** no. Those are dashboard concerns; the CLI flow stays focused on MCP wiring.

## 12. Future Work (Explicitly Deferred)

- TOML merge for Codex (when ecosystem stabilizes around a single config path).
- YAML merge for Aider (low value — small audience).
- "Update" command to refresh existing kontexta entries when paths change.
- Telemetry on which clients are detected/configured (requires the observability layer that's also pending).
