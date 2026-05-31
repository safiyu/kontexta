# kontexta-mcp

[![npm](https://img.shields.io/npm/v/kontexta-mcp.svg)](https://www.npmjs.com/package/kontexta-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

MCP server for [Kontexta](https://kontexta.dev) — **53 tools** that let AI coding agents search, read, edit (section-level), tag, version, clip web content, and run sandboxed commands through a local SQLite-backed knowledge base. Designed for context-window economy: every file-returning response is annotated with `est_tokens` and `size_bytes`.

## Install

The server is launched on demand by your AI client; no global install needed.

```json
{
  "mcpServers": {
    "kontexta": {
      "command": "npx",
      "args": ["-y", "kontexta-mcp"],
      "env": {
        "KONTEXTA_DATA_DIR": "/absolute/path/to/your/data"
      }
    }
  }
}
```

`KONTEXTA_DATA_DIR` **must** be an absolute path. The directory is created on first run and holds your SQLite DB plus the markdown files the agent indexes.

### Bin aliases

The package exposes two CLI entry points:

| Command | Description |
|---|---|
| `kontexta-mcp` | Standard MCP server entry |
| `kxta` | Shorthand alias (same binary) |

Both invoke the same `dist/index.js` — use whichever your client's config format prefers.

## Client config locations

| Client | Path |
|---|---|
| Claude Code | `claude mcp add kontexta -s user -e KONTEXTA_DATA_DIR=/path -- node /path/to/apps/mcp/dist/index.js` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | Settings → Features → MCP |
| Continue | `~/.continue/config.json` |
| Codex | `.codex/mcp_servers.json` |
| GitHub Copilot (VS Code Insider) | VS Code Settings → `mcp.servers` (built-in Copilot chat supports MCP) |
| Gemini / Antigravity | `~/.gemini/antigravity/mcp_servers.json` |

## Web UI (optional)

The MCP server runs headless. If you want the matching three-pane web UI, run the Docker image alongside it (it reads the same `KONTEXTA_DATA_DIR`):

```bash
docker run -d -p 3000:3000 -v /absolute/path/to/your/data:/app/data safiyu/kontexta:latest
```

Open `http://localhost:3000`.

## Tool categories

The 53 tools are organized into these groups:

### Find

| Tool | Purpose |
|---|---|
| `search` | Natural-language keyword search across the knowledge base (FTS5) |
| `regex_search` | Substring/regex search across all indexed files |
| `grep_in_file` | Substring/regex search within a single known file |
| `bundle_search` | Search hits + file bodies in a single token-budgeted call |
| `find_related` | Discover sibling files via tag overlap |
| `suggest_tags` | Propose tags for an existing file |

### Read

| Tool | Purpose |
|---|---|
| `read_file` | Read one file's full body and metadata by ID |
| `read_files` | Batch read up to 200 files by ID in one call |
| `read_file_by_path` | Read a file by absolute path (no ID needed) |
| `read_file_lines` | Read a specific line range from a file |
| `read_section` | Read a section by heading within a file |
| `read_file_outline` | Get a compact outline of a file's structure |
| `describe_file` | Metadata-only inspection (tags, size, history, related) — no body tokens |

### Write

| Tool | Purpose |
|---|---|
| `create_file` | Create a new markdown or mermaid file in the KB or project |
| `create_files` | Create multiple new files in one call |
| `update_file` | Replace the entire body of a file |
| `update_file_section` | Surgical edit at a known heading |
| `delete_file` | Delete a single file |
| `delete_files` | Delete multiple files in one call |
| `move_file` | Rename or relocate a file |

### Organize

| Tool | Purpose |
|---|---|
| `add_tags` | Add tags to an existing file |
| `remove_tags` | Remove tags from a file |
| `list_tags` | Enumerate all tags in the vault |
| `set_favorite` | Pin / unpin a file |
| `tag_search_results` | Bulk-tag every hit from a search |
| `list_folders` | Enumerate folders in a project |
| `create_folder` | Create a new (possibly nested) folder |
| `delete_folder` | Remove an empty folder |
| `list_files` | List files in a project (filterable) |

### History & Recovery

| Tool | Purpose |
|---|---|
| `get_history` | List a file's revisions |
| `get_diff` | Compare two specific revisions |
| `restore_file` | Roll back a KB file to an earlier revision |
| `diff_against_disk` | Detect drift after out-of-band filesystem edits |
| `refresh_index` | Rescan the vault after external changes |

### Discover

| Tool | Purpose |
|---|---|
| `list_projects` | Enumerate registered projects |
| `register_project` | Register a new project root with kontexta |
| `project_map` | Compact folder/file tree with titles and tags |
| `stats` | Counts and health metrics for a project |
| `whats_new` | Files added/changed since a cutoff timestamp |

### Journaling

| Tool | Purpose |
|---|---|
| `journal_note` | Record a free-form decision/abandonment/observation note |
| `journal_intent` | Record a topic/intent pivot |
| `journal_status` | Report journal backlog and high-water mark |
| `distill_journal` | Run the distillation pipeline (raw events → markdown summaries) |
| `distill_journal_commit_upgrades` | Mark mechanical entries as upgraded after subagent dispatch |
| `housekeep_journal` | Run journal retention/archival (prune old raw files, archive cold tasks) |

### Hands (sandboxed commands)

| Tool | Purpose |
|---|---|
| `list_hands` | List every Hands command tool currently registered |
| `reload_hands` | Re-scan projects and rebuild the Hands tool registry |
| `confirm_hand` | Approve a pending Hands invocation by its approval token |
| `describe_hands_schema` | Return the complete `kontexta.json` authoring reference |

### Onboarding

| Tool | Purpose |
|---|---|
| `onboard_agent` | Write/update kontexta workflow rules in agent context files |
| `clip_url` | Clip a web URL into the knowledge base |
| `commit_backup` | Push KB changes to the project's remote git |

## MCP Resources

The server also exposes two MCP resources for URI-based access:

| URI | Description |
|---|---|
| `kontexta://projects` | JSON list of all registered projects with agent-rules status |
| `kontexta://files/{id}` | Markdown content of a specific file by ID |

## Journaling modes

Kontexta's journaling subsystem has three modes, configurable per project in `kontexta.json`:

| Mode | Behavior |
|---|---|
| `lenient` (default) | Never blocks; injects a `journal` envelope on tool responses when backlog exists; auto-distills at 500 events or 7 days |
| `strict` | Blocks read tools (`search`, `read_*`, `list_*`, `describe_*`) with a `JOURNAL_BACKLOG` error when undistilled events exist. Override with `journal_bypass: true` |
| `mechanical-only` | Disables LLM-upgrade tier guidance; mechanical distillation runs every N tool calls in-process |

## Hands — sandboxed command orchestration

Hands lets you declare project-specific commands in `kontexta.json` that agents can run safely:

- **Strict sandbox**: realpath-verified CWD, stripped `PATH`, clean environment, ring-buffer output cap, hard timeouts, process-group kill on timeout, no shell.
- **Cryptographic confirm tokens** (CSPRNG, single-use, 60s expiry) for high-risk commands.
- **ReDoS-proof parameter validation** via `re2`; default `^[^-].*` mitigates argv injection.
- **Human-in-the-loop**: Optional approval flow per command.

## Token-aware responses

Every file-returning tool annotates its response with:

- `size_bytes` — exact byte size of the content
- `est_tokens` — estimated token count (≈1 token per 4 ASCII chars)

This lets agents budget their context window before deciding to fetch more files. A token budget warning is emitted when a project's content exceeds the soft cap (default 100,000 tokens).

## Agent rules

Kontexta injects a version-stamped workflow rules block into agent context files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, etc.) via `onboard_agent`. The server checks for outdated rules on every tool call and surfaces a warning when a newer `rulesVersion` is available.

Supported agents: Claude Code, Cursor, Cline, GitHub Copilot, Gemini, Antigravity, Continue, Cline.

## Graceful shutdown

The MCP server drains in-flight work on `SIGINT`/`SIGTERM`:

1. Kills detached Hands children
2. Flushes the journal capture
3. Awaits in-flight database operations (up to 10s hard ceiling)
4. Closes the database cleanly

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `KONTEXTA_DATA_DIR` | `~/.local/share/kontexta` (Linux) | Vault directory (SQLite DB + markdown files) |
| `KONTEXTA_DB_PATH` | `$KONTEXTA_DATA_DIR/kontexta.db` | Override the database file path |
| `KONTEXTA_DEFAULT_PROJECT_SLUG` | `"default"` | Default project for journal capture |
| `KONTEXTA_AGENT` | `"unknown"` | Agent identifier for journal events |
| `KONTEXTA_PROJECT_PATH` | `process.cwd()` | Project path for git polling |
| `KONTEXTA_PROJECT_TOKEN_WARN` | `100000` | Token budget soft cap warning threshold |
| `KONTEXTA_PROJECTS` | — | Colon-separated list of project directories to auto-register |

## Requirements

- Node ≥ 20 (the package is published as ESM, target node20).
- `better-sqlite3` ships prebuilt binaries for linux/macos/windows on x64 and arm64. If your platform isn't covered (Alpine/musl, RISC-V, older Node), `npm install` falls back to a from-source build that needs `python3` and a C++ toolchain.

## Documentation

Full docs, the complete tool reference with routing matrices, and the web UI live in the [main repository](https://github.com/safiyu/kontexta). See [`CHANGELOG.md`](https://github.com/safiyu/kontexta/blob/main/CHANGELOG.md) for what's new and [`docs/MCP.md`](https://github.com/safiyu/kontexta/blob/main/docs/MCP.md) for the detailed MCP integration guide.

## License

Apache-2.0
