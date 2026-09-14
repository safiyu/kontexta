# MCP Integration & Tool Reference

> **Web UI alternative:** the docs page at `/docs` in the running Kontexta web UI shows the same install snippets and tool reference, with paths pre-filled.

Kontexta's MCP server is a **stdio** transport (`StdioServerTransport`). The host AI tool spawns it as a child process and communicates over stdin/stdout — no network port, no separate process to keep running.

**Tool routing matrix.** When you call `admin.onboard_agent`, the rules block injected into your project's `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/kontexta.mdc` includes a routing matrix for all MCP tools — for each tool, when to use it, when not to, and the better sibling. The block is versioned; bumping `rulesVersion` triggers re-injection on the next `admin.onboard_agent` call, and `admin.overview({mode: "whats_new"})` surfaces the prompt to update.

**Path & environment:**

- **Server entry:** `apps/mcp/dist/index.js` (built by `pnpm build`). The package also exposes a `kontexta-mcp` bin if you `pnpm link` it globally.
- **`KONTEXTA_DATA_DIR`** — override the vault location. Defaults to `~/.local/share/kontexta` (Linux), `~/Library/Application Support/kontexta` (macOS), or `%APPDATA%\kontexta` (Windows). Set this explicitly only if you want a non-standard vault path or need the MCP server and web UI to share a vault that is not the default location.
- **`KONTEXTA_DB_PATH`** (optional) — defaults to `$KONTEXTA_DATA_DIR/kontexta.db`.

The web UI and the MCP server can run against the same database simultaneously. SQLite WAL mode handles the concurrent reads, and the MCP server uses the same migration system, so first launch order doesn't matter.

---

## Content class: dictionary vs note

Every KB file carries a `content_class` — an authority axis, separate from tags and folders. This is the shortest explanation of what the four values mean and when each applies:

| Class | What it is | Examples | Where on disk |
|---|---|---|---|
| **`dictionary`** | AUTHORITATIVE — the file IS a source of truth. Editing is rare; if it disagrees with something else, it wins. | System-ID / MANDT / mapping tables, glossaries, PR templates, canonical architecture descriptions, runbooks, clipped external reference material. | `knowledge/dictionary/**` and `knowledge/urlclips/**` (clipped articles) |
| **`note`** | INFORMATIONAL — a snapshot, a viewpoint, or working knowledge. Useful context but not authoritative. May go stale. | Sprint reviews, meeting prep, PR review findings, session summaries, story stubs, incident post-mortems, working thoughts, current-state write-ups. | `knowledge/notes/**` — plus `mermaid/**` and `html/**` (rendered artifacts) |
| **`journal`** | Time-bucketed log auto-written by the `journal.*` tools. Never manually classified. | Daily activity, hands runs, `journal.write` notes. | `journal/**` |
| **`project`** | File that belongs to a registered project (lives in the project's repo, not the KB). Never manually classified. | Any file under a project's registered path. | Anywhere under a project root |

**Ambiguity test.** For any file you're about to write, ask: *"if this file said something different from the code / the mapping table / the profile — who wins?"* If the file wins → `dictionary`. If the file loses (it's just describing a moment in time) → `note`.

**Retrieval behavior.** Search ranks `dictionary` hits above everything else for the same query, regardless of BM25 score. This is the whole point of the distinction — factual look-ups prefer authoritative content; narrative queries still pick up notes but sort them below. Every read tool (`files.search`, `files.list`, `files.find_related`, `files.regex_search`) also accepts a `kind` filter to narrow to a single class.

**Writing new files.** `files.create` REQUIRES `kind: "dictionary" | "note"` per item for KB destinations — agents must declare intent every time. There's no default fallback. The class routes the file to the right subfolder automatically: pass `kind: "dictionary"` and it lands in `knowledge/dictionary/...`; add an optional folder inside (e.g. `slt/`) to organize further.

**Changing a class.** In the web UI, opening a KB file under `knowledge/{dictionary,notes,urlclips}` shows a small `Dictionary | Note` pill switch in the content-pane header — click the inactive side to move the file to the mirrored path in the other tree (subfolder preserved). From MCP: `files.move` with `kind: "dictionary" | "note"` and no `new_path` does the same server-side.

**Clipping.** `resources.clip_url` writes to `knowledge/urlclips/` and is auto-classified as `dictionary` — clipped external references are treated as authoritative by default. Move a clipped file into `knowledge/notes/` after the fact if it turned out to be informational.

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
docker run -d -p 23002:23002 -v /absolute/path/to/your/data:/app/data safiyu/kontexta:latest
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

1. Run `projects.register` in any other agent (e.g. Claude Code or Cursor).
2. Run `admin.onboard_agent` with `target_agent: aider`. This creates `.aider/kontexta.md`.
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
- **Hermes Agent**: Hermes uses a `mcp_servers` key in `~/.hermes/config.yaml` (or `$HERMES_HOME/config.yaml` when a profile/home override is set). Paste the YAML block from the dashboard's Configure section under it — the `env`/data-directory rules are the same. Two Hermes specifics: MCP servers are loaded at startup only, so restart Hermes after editing (no hot-reload); and on Windows, a bare `npx` command fails to spawn because it is a `.cmd` shim — use the full path instead (e.g. `command: "C:/Program Files/nodejs/npx.cmd"`).

Example Hermes configuration (npm install):

```yaml
mcp_servers:
  kxta:
    command: "npx"
    args: ["-y", "kontexta", "mcp"]
```

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
| `hands.list` | Lists every registered Hand across all projects: project, tool name, danger level, confirm-required flag, description. Pass `schema: true` to instead get the full authoring reference for `kontexta.json`: schema, validation rules, security guarantees, limitations, recommended practices, annotated example. |
| `hands.reload` | Re-scans every registered project's `kontexta.json` and refreshes the registry. Use after editing a config mid-session. |
| `hands.confirm` | Approves a pending execution by token. Single-use, expires in 60s, bound to the resolved invocation. |
| `<project>__<tool-name>` | Dynamically registered per project from each `kontexta.json`. Namespaced with double-underscore for collision-free agent transcripts. |

**Authoring reference:** `hands.list({ schema: true })` returns ~10 KB of Markdown — the single source of truth for what's valid in a `kontexta.json`. Read it via the MCP tool itself, or see [`kontexta.json` design spec](../docs/superpowers/specs/2026-05-02-hands-design.md).

---

## Brain tools

The MCP server exposes 58 tools designed for agents that care about context-window economy. Every file-returning response is annotated with `est_tokens` and `size_bytes`; list/search responses also inline `tags` and `match_excerpt` so a single call usually replaces 3-5.

### Reading

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `files.read` | Read by `id` or `path`; batch via `ids` (≤200); partial read via `section` (one heading's body) or `lines` (1-indexed range, clamps out-of-range). | "Read Kontexta file 42." / "Read lines 40-60 of the auth note." |
| `files.read_outline` | Heading-only outline (level, text, line, byte range) — survey before pulling. | "What sections does the deployment doc have?" |
| `files.describe` | Everything ABOUT a file without pulling its content: tags, size, history depth, related files, backlinks. Replaces 3-4 chained calls. | "Tell me about file 31 without loading it." |
| `files.list` | Filter by project / tag / folder / favorite / untagged; results carry tags + tokens inline. | "List untagged KB files." |

### Writing

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `files.create` | One file, or a `files` array for batch create (≤200). | "Save these three migration plans as separate files." |
| `files.update` | Replace whole file content; auto-commits to git. Pass `section` to instead surgically replace one heading's body without touching siblings — same git/FTS path. | "Update the API contract note with these changes." / "Replace the 'Setup' section of the auth note with this." |
| `files.delete` | One file, or an `ids` array for batch delete (≤500). KB files are unlinked from disk; project-reference files are only un-indexed. | "Delete files 12, 15, and 18." |
| `files.move` | Rename / relocate. Validation refuses cross-project / cross-section moves. | "Rename file 7 to `archive/auth-2024.md`." |
| `journal.write` | Record an event: `kind: "note"` (free-form decision/abandonment/observation, surfaces in distilled task entries), `kind: "intent"` (topic pivot so distillation knows the focus shifted), or `kind: "append"` (timestamped daily journal entry). | "Note: Abandoned the Redis cache approach due to serialization overhead." |
| `journal.distill` | Run mechanical distillation on accumulated raw events. Writes per-topic markdown entries; idempotent. Defaults to current project. | "Distill the journal for this project." |
| `journal.status` | Report the current backlog and high-water mark for the project's journal. | "Show me the journal status." |
| `journal.housekeep` | Run journal retention/archival for a project. Idempotent. Prunes old raw .jsonl files and archives cold tasks. | "Run journal housekeeping for this project." |
| `journal.commit_upgrades` | After dispatching subagents to upgrade mechanical entries to LLM-narrative, mark them as upgraded in the index. | "Mark these task slugs as upgraded." |

### Search

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `files.search` | FTS5 full-text. Returns `match_excerpt` (16-token window with `<<<…>>>` markers) and `title_highlight` so agents see WHERE the match was without re-reading the file. Pass `include_bodies: true` to instead get matches concatenated into one prompt-ready blob (XML or Markdown), stopping at `max_tokens` budget with overflow in `meta.skipped[]`. | "Search for `OAuth` across all Kontexta." / "Bundle the top 5 deployment notes under 30k tokens." |
| `files.find_related` | Files sharing tags with a given file, ranked by overlap. Surfaces context the same query wouldn't find. | "Find files related to the auth note." |
| `files.regex_search` | Cross-file regex when FTS5's tokenizer misses (URLs, code identifiers, hyphenated terms); scope by project, or pass `file_id` for a single known file with line numbers. `max_files` / `max_matches_per_file` bound multi-file cost. | "Find every mention of `oa-data-rmspcockpit-[a-z]+` in the project." / "Find every `fact_*` table reference in file 83." |

### Tagging & favorites

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `tags.add`, `tags.remove`, `tags.list`, `tags.set_favorite` | The basics. | "Tag file 22 with `infra` and `2024-q4`." |
| `tags.suggest` | Proposes tags from your existing corpus by FTS-matching the file's distinctive terms against tagged neighbors. No LLM. | "Suggest tags for file 31." |
| `tags.search` | Run a search, then bulk-apply tags to every match. | "Tag every file matching 'kubernetes' with `infra`." |

### Folders & projects

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `folders.list`, `folders.create`, `folders.delete` | Folder CRUD. `folders.delete` refuses project folders (the watcher would re-ingest); KB only. | "Create a `journal` folder under the KB." |
| `projects.register`, `projects.list` | Add an external repo as a project; Kontexta indexes its `.md` files. Warns when total tokens exceed `KONTEXTA_PROJECT_TOKEN_WARN`. The response also carries a `recommendation` field — update or create — telling the agent whether it should follow up with `admin.onboard_agent`. | "Register `~/code/foo` as a project." |
| `admin.onboard_agent` | Writes or updates a fenced, version-stamped kontexta workflow rules block into a project's agent context file(s) — `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursor/rules/*.mdc` / `.continue/rules/*.md` / `.aider/kontexta.md` / `.clinerules` / `.github/copilot-instructions.md`. Idempotent (skips on same version, splices on bump). Update mode targets detected files; create mode scaffolds the canonical filename for the chosen `target_agent`. Run after `projects.register` when its recommendation suggests it, or any time to refresh the block. | "Onboard this project for Claude Code." |
| `projects.map` | Single-call indented outline of folders + file titles + tags + ids — typically 5× denser than `files.list`. | "Give me a map of the `acme` project." |
| `admin.overview` | `mode: "stats"` for counts (files, untagged, favorites, top tags, by-project breakdown, optional total token cost); `mode: "whats_new"` for files created or modified since a checkpoint (`"30m"`, `"7d"`, ISO timestamp). | "How many untagged files are in the KB?" / "What changed in Kontexta in the last 24h?" |

### Versioning & integrity

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `files.get_history`, `files.get_diff`, `files.restore` | Per-file git log, unified diff between commits, restore to any commit. | "Diff the auth note between this week and last." |
| `admin.commit_backup` | Sync a project's reference files to its global-vault backup tree (push to remote if configured). | "Back up the `acme` project." |
| `files.diff_against_disk` | Reports drift between disk content and the FTS index (after external edits / sync merges). Returns `in_sync` / `diverged` / `disk_unreadable` / `no_index_row`. | "Did anything change on disk that I missed?" |
| `projects.refresh_index` | Re-scan the KB (or one project) and reconcile the FTS index — picks up new files, refreshes drifted hashes, prunes vanished rows. The MCP server has no file watcher (the web app does), so this is the explicit fix-up after editor / sync writes. | "Refresh the KB index." |

### Discovery

| Tool | What it does | Example prompt |
| :--- | :--- | :--- |
| `resources.clip_url` | Fetch + Readability-extract a web page into the KB. Detects auth walls (Confluence, SSO, login pages) and returns `AUTH_REQUIRED` with a `login_url` so the agent can retry with `headers: { Cookie: … }`. | "Clip `https://wiki/confluence/…`; if it's gated, ask me for a cookie." |

---

## Tool response shape

Every file-returning tool annotates its response with `size_bytes` and `est_tokens` so agents can budget their context window before pulling content. The estimator samples each file's head and uses `bytes/4` for ASCII-heavy content (~10% accurate vs BPE) or `bytes/3` for multi-byte (CJK/emoji). List-style tools also carry a `total_est_tokens` summary.

| Tool | Response shape |
| :--- | :--- |
| `files.read` (single: `id`/`path`) | `{ ...file, size_bytes, est_tokens }` |
| `files.read` (batch: `ids`) | `{ files: [...annotated], total_est_tokens, error_count, errors: [{ id, error }] }` |
| `files.read` (partial: `section`) | `{ file_id, path, heading, level, line, content, size_bytes, est_tokens }` |
| `files.read` (partial: `lines`) | `{ file_id, path, from, to, total_lines, content, size_bytes, est_tokens }` |
| `files.create` | `{ created_count, error_count, created: [...annotated], errors: [{ index, title, error }] }` — per-item failures don't abort the batch |
| `files.update`, `files.update` (with `section`) | `{ ...file, size_bytes, est_tokens }` |
| `files.delete` | `{ deleted_count, error_count, deleted: [...ids], errors: [{ id, error }] }` — per-item failures don't abort the batch |
| `files.list` | `{ files: [{ ...file, tags, size_bytes, est_tokens }], total_est_tokens }` |
| `files.search` (default) | `{ matches: [{ ...file, tags, size_bytes, est_tokens, match_excerpt, title_highlight }], total_est_tokens }` — excerpts wrap hits in `<<<…>>>` markers |
| `files.search` (`include_bodies: true`) | `{ bundle, meta: { query, format, total_est_tokens, included: [{id, path, est_tokens}], skipped: [{..., reason}] } }` |
| `admin.overview` (`mode: "whats_new"`) | `{ since, until, count, total_est_tokens, files: [{ ...file, change: "created"\|"modified", tags, size_bytes, est_tokens }] }` |
| `admin.overview` (`mode: "stats"`) | `{ scope, file_count, untagged_count, favorite_count, top_tags: [{name, count}], by_project?, total_est_tokens? }` |
| `projects.map` | `{ stats: { files, folders, roots, truncated }, est_tokens, outline }` (outline is an indented text string with `[id] Title  #tag1 #tag2` per leaf) |
| `projects.register` | `{ project, discovered_files_count, total_est_tokens, discovered_files: [...annotated], hands: { found, tools_registered, tools_disabled, warnings }, recommendation: { kind: "onboard_agent", mode: "update"\|"create", reason, target_files, next_tool, next_args }, warnings? }` |
| `admin.onboard_agent` | `{ written: [{ path, action: "created"\|"updated"\|"skipped", version }], skipped: [{ path, reason }] }` |
| `projects.list` | `[{ ...project, has_hands }]` |
| `files.read_outline` | `{ file_id, path, title, outline: [{ level, text, line, byteStart, byteEnd }] }` |
| `files.describe` | `{ id, path, title, project_id, project_name, folder, storage_type, tags, favorite, size_bytes, est_tokens, history_count, related: [{id, shared_tag_count}], backlinks: [{id, title, path}] }` — no `content` |
| `files.regex_search` (single: `file_id`) | `{ file_id, path, pattern, match_count, truncated, matches: [{line, text}] }` |
| `files.regex_search` (default: multi-file) | `{ pattern, files_scanned, files_truncated, file_hit_count, total_match_count, hits: [{file_id, path, title, match_count, matches: [{line, text}]}] }` |
| `tags.search` | `{ matched_count, tagged_count, tags_applied, tagged_ids, errors }` |
| `folders.list` | `{ folders: string[], base_path }` |
| `files.move` | `{ ...file }` (post-move record) |
| `tags.suggest` | `{ file_id, path, existing_tags: string[], suggestions: [{ tag, score, sources }] }` |
| `files.diff_against_disk` | `{ status: "in_sync" \| "diverged" \| "disk_unreadable" \| "no_index_row", ...sizes, first_diff_line?, disk_sample?, index_sample? }` |
| `projects.refresh_index` | `{ scope, newly_indexed, refreshed, pruned }` |
| `journal.write` (`kind: "note"` or `"intent"`) | `{ ok: true, recorded_at: ISO_timestamp }` |
| `journal.write` (`kind: "append"`) | `{ file_id }` |
| `journal.distill` | `{ entries_written, topics_covered, high_water_advanced, events_processed }` |
| `journal.status` | `{ slug, high_water, mode: "lenient" }` |
| `journal.housekeep` | `{ raw_files_pruned, archived_tasks, pending_deletions_marked, purged }` |
| `journal.commit_upgrades` | `{ updated, missing }` |
| `resources.clip_url` (auth-walled) | `isError: true` with `{ code: "AUTH_REQUIRED", auth_required: true, login_url, signal, www_authenticate?, hint }` — retry with `headers: {"Cookie": "..."}` or `{"Authorization": "Bearer ..."}` |
| `hands.list` (default) | `{ hands: [{ project, tool, full, danger, confirm, description, disabled }] }` |
| `hands.list` (`schema: true`) | Markdown text — full authoring reference |
| `hands.reload` | `{ totalRegistered, totalDisabled, perProject: [{ project, registered, disabled, warnings }] }` |
| `hands.confirm` | Markdown text — same shape as a direct Hands tool execution result |
| `<project>__<tool-name>` | Markdown text — status, duration, working dir, fenced stdout, optional fenced stderr |

**`files.search({ include_bodies: true })`** returns the matched files concatenated into a single prompt-ready blob — saves an agent the round-trips of a plain `files.search` + N × `files.read` when it needs several related files for context. Inputs mirror default `files.search` (`query`, `project_id`, `tags`, `favorite`) plus `format` (`"xml"` for Anthropic-recommended `<document>` tags, `"markdown"` for `##` headers + fenced blocks; default `"xml"`) and `max_tokens` (budget cap, default 50000). Files are added in rank order and the bundle stops at the first file that would exceed the budget; remaining hits land in `meta.skipped[]` with their estimated size so the agent can decide whether to re-call with a larger budget.

> [!NOTE]
> `files.list` and `files.search` previously returned bare arrays. Clients that pre-parsed the array directly need to read `.files` / `.matches` instead.
