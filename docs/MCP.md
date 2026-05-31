# MCP Integration & Tool Reference

> **Web UI alternative:** the docs page at `/docs` in the running Kontexta web UI shows the same install snippets and tool reference, with paths pre-filled.

Kontexta's MCP server is a **stdio** transport (`StdioServerTransport`). The host AI tool spawns it as a child process and communicates over stdin/stdout — no network port, no separate process to keep running.

**Tool routing matrix.** When you call `onboard_agent`, the rules block injected into your project's `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/kontexta.mdc` includes a routing matrix for all MCP tools — for each tool, when to use it, when not to, and the better sibling. The block is versioned; bumping `rulesVersion` triggers re-injection on the next `onboard_agent` call, and `whats_new` surfaces the prompt to update.

**Path & environment:**

- **Server entry:** `apps/mcp/dist/index.js` (built by `pnpm build`). The package also exposes a `kontexta-mcp` bin if you `pnpm link` it globally.
- **`KONTEXTA_DATA_DIR`** — override the vault location. Defaults to `~/.local/share/kontexta` (Linux), `~/Library/Application Support/kontexta` (macOS), or `%APPDATA%\kontexta` (Windows). Set this explicitly only if you want a non-standard vault path or need the MCP server and web UI to share a vault that is not the default location.
- **`KONTEXTA_DB_PATH`** (optional) — defaults to `$KONTEXTA_DATA_DIR/kontexta.db`.

The web UI and the MCP server can run against the same database simultaneously. SQLite WAL mode handles the concurrent reads, and the MCP server uses the same migration system, so first launch order doesn't matter.

---

## Install via npm

If you only need the MCP server (no web UI), install via npm — no Docker required:

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

`KONTEXTA_DATA_DIR` must be an absolute path. The directory is created on first run. `npx -y kontexta-mcp` downloads the package on first use and caches it; subsequent invocations are instant.

If you also want the web UI, run the Docker image alongside the npx install — both read the same `KONTEXTA_DATA_DIR`:

```bash
docker run -d -p 3000:3000 -v /absolute/path/to/your/data:/app/data safiyu/kontexta:latest
```

---

## Claude Code

```bash
claude mcp add kontexta -s user \
  -e KONTEXTA_DATA_DIR=/absolute/path/to/your/data \
  -- node /absolute/path/to/apps/mcp/dist/index.js
```

Note the order: `-s` and `-e` are flags to `claude mcp add` and must appear **before** the `--` separator. Anything after `--` is the command + args that Claude Code will spawn.

---

## Aider

Aider does **not** natively support MCP. Integration is file-based: Kontexta writes workflow rules into `.aider/kontexta.md`, which you then link in your Aider configuration.

1. Run `register_project` in any other agent (e.g. Claude Code or Cursor).
2. Run `onboard_agent` with `target_agent: aider`. This creates `.aider/kontexta.md`.
3. Add the following to your `.aider.conf.yml`:

```yaml
read:
  - .aider/kontexta.md
```

This ensures Aider loads Kontexta's workflow rules as read-only context in every session.

---

## Manual configuration

For Claude Desktop, Cursor, Continue, Gemini, Antigravity, and other clients that read a JSON config file:

```json
{
  "mcpServers": {
    "kontexta": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp/dist/index.js"],
      "env": {
        "KONTEXTA_DATA_DIR": "/absolute/path/to/your/data"
      }
    }
  }
}
```

Use absolute paths — most clients launch the process from their own working directory.

**Configuration paths:**

- **Antigravity & Gemini**: `~/.gemini/antigravity/mcp_servers.json`
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Codex**: `.codex/mcp_servers.json`
- **Continue.dev**: `~/.continue/config.json` — add to the `mcpServers` array.
- **Cursor**: `Settings → Features → MCP`
- **Cline**: `~/.cline/mcp_settings.json` — the Cline extension for VS Code / Cursor reads this file directly. After adding the config, reload the VS Code / Cursor window.

---

## Docker-based configuration

If Kontexta is running in Docker, the MCP server lives at `/app/apps/mcp/dist/index.js` inside the container. No `env` block is needed — `KONTEXTA_DATA_DIR=/app/data` is already set by the compose file.

### Same machine (AI client on the same host as the container)

Use `docker exec` to spawn the MCP process directly:

```json
{
  "mcpServers": {
    "kontexta": {
      "command": "docker",
      "args": ["exec", "-i", "kontexta", "node", "/app/apps/mcp/dist/index.js"]
    }
  }
}
```

`-i` keeps stdin open (required for the stdio transport). `kontexta` is the `container_name` from the compose file — change it if you renamed the container.

### Mounting your projects (required for indexing)

For the Docker-based MCP server to see your local files, you **must** mount your projects directory in `docker-compose.yml`:

```yaml
volumes:
  - ${DATA_DIR:-./kontexta-data}:/app/data
  - ${PROJECT_DIR}:${PROJECT_DIR}  # Mount your host projects directory to the SAME absolute path inside the container (REQUIRED)
```

> [!TIP]
> To ensure the AI client (running on your host) and the MCP server (running in the container) agree on file paths, mount the host path to the same absolute path inside the container. The compose file exposes `KONTEXTA_PROJECTS_ROOT=${PROJECT_DIR}` so in-container tools know where projects live. `PROJECT_DIR` should be an absolute path on the host (e.g., `/home/safiyu/Projects`).

> **Startup check:** the compose file sets an entrypoint that fails fast if `PROJECT_DIR` is not defined, preventing accidental runs without a mounted projects directory.

---

## Hands tools

The Hands command-orchestration layer adds these top-level MCP tools, plus N dynamically-registered per-project tools.

| Tool | What it does |
| :--- | :--- |
| `list_hands` | Lists every registered Hand across all projects: project, tool name, danger level, confirm-required flag, description. |
| `reload_hands` | Re-scans every registered project's `kontexta.json` and refreshes the registry. Use after editing a config mid-session. |
| `confirm_hand` | Approves a pending execution by token. Single-use, expires in 60s, bound to the resolved invocation. |
| `describe_hands_schema` | Returns the full authoring reference for `kontexta.json`: schema, validation rules, security guarantees, limitations, recommended practices, annotated example. Use this when helping a user write a `kontexta.json`. |
| `<project>__<tool-name>` | Dynamically registered per project from each `kontexta.json`. Namespaced with double-underscore for collision-free agent transcripts. |

**Authoring reference:** `describe_hands_schema` returns ~10 KB of Markdown — the single source of truth for what's valid in a `kontexta.json`. Read it via the MCP tool itself, or see [`kontexta.json` design spec](../docs/superpowers/specs/2026-05-02-hands-design.md).

---

## Brain tools

The MCP server exposes 49 tools designed for agents that care about context-window economy. Every file-returning response is annotated with `est_tokens` and `size_bytes`; list/search responses also inline `tags` and `match_excerpt` so a single call usually replaces 3-5.

### Reading

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `read_file` | Full file contents + token estimate. | "Read Kontexta file 42." |
| `read_files` | Batch read by id (≤200) — symmetric to `create_files` / `delete_files`. | "Read files 12, 15, and 19 in one call." |
| `read_file_by_path` | Same as `read_file` but looked up by absolute path — bridges from your shell's cwd. | "Read `/Users/me/notes/auth.md` from Kontexta." |
| `read_file_outline` | Heading-only outline (level, text, line, byte range) — survey before pulling. | "What sections does the deployment doc have?" |
| `read_section` | Just one heading's body — the rest of the file stays out of context. | "Read the 'Rotation' section of the auth notes." |
| `read_file_lines` | Line-range slice (1-indexed, clamps out-of-range). Honors stack-trace-style references. | "Read lines 40-60 of the auth note." |
| `describe_file` | Everything ABOUT a file without pulling its content: tags, size, history depth, related files, backlinks. Replaces 3-4 chained calls. | "Tell me about file 31 without loading it." |
| `list_files` | Filter by project / tag / folder / favorite / untagged; results carry tags + tokens inline. | "List untagged KB files." |

### Writing

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `create_file`, `create_files` | Single or batch (≤200) create. | "Save these three migration plans as separate files." |
| `update_file` | Replace whole file content; auto-commits to git. | "Update the API contract note with these changes." |
| `update_file_section` | **Surgical**: replace one heading's body without touching siblings. Same git/FTS path as `update_file`. | "Replace the 'Setup' section of the auth note with this." |
| `delete_file`, `delete_files` | Single or batch (≤500) delete. KB files are unlinked from disk; project-reference files are only un-indexed. | "Delete files 12, 15, and 18." |
| `move_file` | Rename / relocate. Validation refuses cross-project / cross-section moves. | "Rename file 7 to `archive/auth-2024.md`." |
| `journal_note` | Record a free-form decision/abandonment/observation note. Stored as a tagged journal event; surfaces in distilled task entries. | "Note: Abandoned the Redis cache approach due to serialization overhead." |
| `journal_intent` | Record a topic pivot in the project's journal so distillation knows the focus shifted. | "User redirected to authentication flow work." |
| `distill_journal` | Run mechanical distillation on accumulated raw events. Writes per-topic markdown entries; idempotent. Defaults to current project. | "Distill the journal for this project." |
| `journal_status` | Report the current backlog and high-water mark for the project's journal. | "Show me the journal status." |
| `housekeep_journal` | Run journal retention/archival for a project. Idempotent. Prunes old raw .jsonl files and archives cold tasks. | "Run journal housekeeping for this project." |
| `distill_journal_commit_upgrades` | After dispatching subagents to upgrade mechanical entries to LLM-narrative, mark them as upgraded in the index. | "Mark these task slugs as upgraded." |

### Search

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `search` | FTS5 full-text. Returns `match_excerpt` (16-token window with `<<<…>>>` markers) and `title_highlight` so agents see WHERE the match was without re-reading the file. | "Search for `OAuth` across all Kontexta." |
| `bundle_search` | Search + concatenate matches into one prompt-ready blob (XML or Markdown). Stops at `max_tokens` budget; overflow lands in `skipped[]`. | "Bundle the top 5 deployment notes under 30k tokens." |
| `find_related` | Files sharing tags with a given file, ranked by overlap. Surfaces context the same query wouldn't find. | "Find files related to the auth note." |
| `regex_search` | Cross-file regex when FTS5's tokenizer misses (URLs, code identifiers, hyphenated terms). Scope by project; `max_files` / `max_matches_per_file` bound the cost. | "Find every mention of `oa-data-rmspcockpit-[a-z]+` in the project." |
| `grep_in_file` | Within-file regex with line numbers — different from FTS5; catches what tokenizer-based search can't. | "Find every `fact_*` table reference in file 83." |

### Tagging & favorites

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `add_tags`, `remove_tags`, `list_tags`, `set_favorite` | The basics. | "Tag file 22 with `infra` and `2024-q4`." |
| `suggest_tags` | Proposes tags from your existing corpus by FTS-matching the file's distinctive terms against tagged neighbors. No LLM. | "Suggest tags for file 31." |
| `tag_search_results` | Run a search, then bulk-apply tags to every match. | "Tag every file matching 'kubernetes' with `infra`." |

### Folders & projects

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `list_folders`, `create_folder`, `delete_folder` | Folder CRUD. `delete_folder` refuses project folders (the watcher would re-ingest); KB only. | "Create a `journal` folder under the KB." |
| `register_project`, `list_projects` | Add an external repo as a project; Kontexta indexes its `.md` files. Warns when total tokens exceed `KONTEXTA_PROJECT_TOKEN_WARN`. The response also carries a `recommendation` field — update or create — telling the agent whether it should follow up with `onboard_agent`. | "Register `~/code/foo` as a project." |
| `onboard_agent` | Writes or updates a fenced, version-stamped kontexta workflow rules block into a project's agent context file(s) — `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursor/rules/*.mdc` / `.continue/rules/*.md` / `.aider/kontexta.md` / `.clinerules` / `.github/copilot-instructions.md`. Idempotent (skips on same version, splices on bump). Update mode targets detected files; create mode scaffolds the canonical filename for the chosen `target_agent`. Run after `register_project` when its recommendation suggests it, or any time to refresh the block. | "Onboard this project for Claude Code." |
| `project_map` | Single-call indented outline of folders + file titles + tags + ids — typically 5× denser than `list_files`. | "Give me a map of the `acme` project." |
| `stats` | Counts: files, untagged, favorites, top tags, by-project breakdown. Optional total token cost. | "How many untagged files are in the KB?" |

### Versioning & integrity

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `get_history`, `get_diff`, `restore_file` | Per-file git log, unified diff between commits, restore to any commit. | "Diff the auth note between this week and last." |
| `commit_backup` | Sync a project's reference files to its global-vault backup tree (push to remote if configured). | "Back up the `acme` project." |
| `diff_against_disk` | Reports drift between disk content and the FTS index (after external edits / sync merges). Returns `in_sync` / `diverged` / `disk_unreadable` / `no_index_row`. | "Did anything change on disk that I missed?" |
| `refresh_index` | Re-scan the KB (or one project) and reconcile the FTS index — picks up new files, refreshes drifted hashes, prunes vanished rows. The MCP server has no file watcher (the web app does), so this is the explicit fix-up after editor / sync writes. | "Refresh the KB index." |

### Discovery

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `whats_new` | Files created or modified since a checkpoint (`"30m"`, `"7d"`, ISO timestamp). Each entry tagged `created`/`modified`. | "What changed in Kontexta in the last 24h?" |
| `clip_url` | Fetch + Readability-extract a web page into the KB. Detects auth walls (Confluence, SSO, login pages) and returns `AUTH_REQUIRED` with a `login_url` so the agent can retry with `headers: { Cookie: … }`. | "Clip `https://wiki/confluence/…`; if it's gated, ask me for a cookie." |

---

## Tool response shape

Every file-returning tool annotates its response with `size_bytes` and `est_tokens` so agents can budget their context window before pulling content. The estimator samples each file's head and uses `bytes/4` for ASCII-heavy content (~10% accurate vs BPE) or `bytes/3` for multi-byte (CJK/emoji). List-style tools also carry a `total_est_tokens` summary.

| Tool | Response shape |
| :--- | :--- |
| `read_file`, `read_file_by_path`, `create_file`, `update_file`, `update_file_section` | `{ ...file, size_bytes, est_tokens }` |
| `list_files` | `{ files: [{ ...file, tags, size_bytes, est_tokens }], total_est_tokens }` |
| `search` | `{ matches: [{ ...file, tags, size_bytes, est_tokens, match_excerpt, title_highlight }], total_est_tokens }` — excerpts wrap hits in `<<<…>>>` markers |
| `whats_new` | `{ since, until, count, total_est_tokens, files: [{ ...file, change: "created"\|"modified", tags, size_bytes, est_tokens }] }` |
| `project_map` | `{ stats: { files, folders, roots, truncated }, est_tokens, outline }` (outline is an indented text string with `[id] Title  #tag1 #tag2` per leaf) |
| `register_project` | `{ project, discovered_files_count, total_est_tokens, discovered_files: [...annotated], hands: { found, tools_registered, tools_disabled, warnings }, recommendation: { kind: "onboard_agent", mode: "update"\|"create", reason, target_files, next_tool, next_args }, warnings? }` |
| `onboard_agent` | `{ written: [{ path, action: "created"\|"updated"\|"skipped", version }], skipped: [{ path, reason }] }` |
| `list_projects` | `[{ ...project, has_hands }]` |
| `bundle_search` | `{ bundle, meta: { query, format, total_est_tokens, included: [{id, path, est_tokens}], skipped: [{..., reason}] } }` |
| `read_file_outline` | `{ file_id, path, title, outline: [{ level, text, line, byteStart, byteEnd }] }` |
| `read_section` | `{ file_id, path, heading, level, line, content, size_bytes, est_tokens }` |
| `read_file_lines` | `{ file_id, path, from, to, total_lines, content, size_bytes, est_tokens }` |
| `read_files` | `{ files: [...annotated], total_est_tokens, error_count, errors: [{ id, error }] }` |
| `describe_file` | `{ id, path, title, project_id, project_name, folder, storage_type, tags, favorite, size_bytes, est_tokens, history_count, related: [{id, shared_tag_count}], backlinks: [{id, title, path}] }` — no `content` |
| `grep_in_file` | `{ file_id, path, pattern, match_count, truncated, matches: [{line, text}] }` |
| `regex_search` | `{ pattern, files_scanned, files_truncated, file_hit_count, total_match_count, hits: [{file_id, path, title, match_count, matches: [{line, text}]}] }` |
| `create_files`, `delete_files` | `{ created\|deleted_count, error_count, created\|deleted: [...], errors: [{ index\|id, error }] }` — per-item failures don't abort the batch |
| `tag_search_results` | `{ matched_count, tagged_count, tags_applied, tagged_ids, errors }` |
| `list_folders` | `{ folders: string[], base_path }` |
| `move_file` | `{ ...file }` (post-move record) |
| `stats` | `{ scope, file_count, untagged_count, favorite_count, top_tags: [{name, count}], by_project?, total_est_tokens? }` |
| `suggest_tags` | `{ file_id, path, existing_tags: string[], suggestions: [{ tag, score, sources }] }` |
| `diff_against_disk` | `{ status: "in_sync" \| "diverged" \| "disk_unreadable" \| "no_index_row", ...sizes, first_diff_line?, disk_sample?, index_sample? }` |
| `refresh_index` | `{ scope, newly_indexed, refreshed, pruned }` |
| `journal_note` | `{ ok: true, recorded_at: ISO_timestamp }` |
| `journal_intent` | `{ ok: true, recorded_at: ISO_timestamp }` |
| `distill_journal` | `{ entries_written, topics_covered, high_water_advanced, events_processed }` |
| `journal_status` | `{ slug, high_water, mode: "lenient" }` |
| `housekeep_journal` | `{ raw_files_pruned, archived_tasks, pending_deletions_marked, purged }` |
| `distill_journal_commit_upgrades` | `{ updated, missing }` |
| `clip_url` (auth-walled) | `isError: true` with `{ code: "AUTH_REQUIRED", auth_required: true, login_url, signal, www_authenticate?, hint }` — retry with `headers: {"Cookie": "..."}` or `{"Authorization": "Bearer ..."}` |
| `list_hands` | `{ hands: [{ project, tool, full, danger, confirm, description, disabled }] }` |
| `reload_hands` | `{ totalRegistered, totalDisabled, perProject: [{ project, registered, disabled, warnings }] }` |
| `confirm_hand` | Markdown text — same shape as a direct Hands tool execution result |
| `describe_hands_schema` | Markdown text — full authoring reference |
| `<project>__<tool-name>` | Markdown text — status, duration, working dir, fenced stdout, optional fenced stderr |

**`bundle_search`** runs a full-text search and returns the matched files concatenated into a single prompt-ready blob — saves an agent the round-trips of `search` + N × `read_file` when it needs several related files for context. Inputs mirror `search` (`query`, `project_id`, `tags`, `favorite`) plus `format` (`"xml"` for Anthropic-recommended `<document>` tags, `"markdown"` for `##` headers + fenced blocks; default `"xml"`) and `max_tokens` (budget cap, default 50000). Files are added in rank order and the bundle stops at the first file that would exceed the budget; remaining hits land in `meta.skipped[]` with their estimated size so the agent can decide whether to re-call with a larger budget.

> [!NOTE]
> `list_files` and `search` previously returned bare arrays. Clients that pre-parsed the array directly need to read `.files` / `.matches` instead.
