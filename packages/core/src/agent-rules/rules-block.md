<!--
Source of truth for the kontexta agent rules block.

Authoring rules:
1. One clause per cell. <= 80 chars. Verbs, no fluff.
2. "When NOT" is the documented failure mode, not a hypothetical edge case.
3. "Use instead" is the BETTER sibling tool. Empty if no sibling.
4. Every row stands alone — no cross-references.
5. Every new server.tool() in apps/mcp/src/index.ts MUST add a row in the
   relevant bucket below AND bump rulesVersion in packages/core/package.json.
   Tests enforce this.

The placeholder {{VERSION}} is substituted at module init with RULE_BLOCK_VERSION.
-->
<!-- BEGIN kontexta:rules v{{VERSION}} -->
## Working with kontexta

This project is registered with kontexta. Honor these rules to keep the index, history, and journal coherent — and to avoid burning tokens on workflows kontexta already solves. Tools live under the `kxta` MCP server.

### Core rules

**Search before reading.** Use `search`, `bundle_search`, or `regex_search` to find context first. Skipping straight to `read_file` on a guessed path wastes tokens and often misses the right file.

**All KB writes go through kontexta.** Use `create_file` / `update_file` / `update_file_section` / `journal_note`. **Never** edit a KB file with raw filesystem tools (Edit/Write/cat) — the watcher and FTS index will diverge until `refresh_index` runs, and subsequent searches will return stale results.

**Batch reads. Don't loop `read_file`.** Need ≥2 files? Call `read_files` (one round-trip, up to 200 IDs) or `bundle_search` (token-budgeted blob). Looping `read_file` wastes round-trips and inflates response overhead.

**Address `journal.suggested_action` before the next tool call.** Many tool responses include a `journal` envelope. If `journal.suggested_action` is set (e.g., `"distill_journal"`), call that tool before issuing your next tool. To dismiss for the rest of the session, pass `journal_acknowledge: true` on your next tool call.

**Use `journal_note(text, tags)` for decisions and abandonments.** When you make a non-obvious call, try something that doesn't work, or capture a workaround, log it. Hands runs are auto-captured now.

**Use `journal_intent(summary)` when the user pivots.** One short sentence so the distillation step knows the topic shifted.

**Strict mode awareness.** If a project sets `journal.mode = "strict"` in its `kontexta.json`, the MCP server returns a `JOURNAL_BACKLOG` error on read tools (search/read_*/list_*) when undistilled events exist. The error includes `next_action: "distill_journal"`. Either run `distill_journal` first, OR pass `journal_bypass: true` on the read call to override (logged for audit).

**Confirm Hands tokens within 60 seconds.** When a Hands tool returns an approval token, do NOT chain a long question or another tool call before `confirm_hand`. Tokens expire; the user will have to re-issue the whole flow.

**Save specs to a canonical location.** When generating a spec, plan, or design doc, write it to the KB at `specs/<project-name>/<spec-name>.md` (use `create_file` with `destination: "knowledge"`, `folder: "specs/<project-name>"`). One folder per project keeps specs queryable.

**Tag new KB files at creation time.** Pass `tags` on `create_file`, or call `add_tags` immediately after. Untagged files are recoverable but invisible to `find_related`.

**`whats_new` early. `commit_backup` late.** Run `whats_new` at session start if you've been away — it returns files added/changed since a cutoff. End the session with `commit_backup` if you mutated KB files and the project has a remote.

**Use `.mmd` for diagrams, not fenced code in `.md`.** When creating an architecture / flow / sequence diagram, call `create_file` with `format: "mmd"` and put the raw mermaid source as the body (no ```` ```mermaid ```` fence). The web UI renders `.mmd` files as live diagrams with SVG/PNG export; mermaid embedded in markdown is just text. Default folder: `mermaid/` (or `<project>/mermaid/` for project-scoped diagrams).


### Knowledge Items (KI)

KIs are curated, distilled KB files — the highest-signal context in the vault. 
They save tokens and prevent redundant research when used correctly.

**Check KIs before independent research.** At the start of any task, run 
`search` or `bundle_search` over the KB for the task topic. If a matching KI 
exists, read it before writing code, designing architecture, or forming a plan. 
Skipping this step is the single most common source of duplicated work.

**KIs are starting points, not ground truth.** KIs are snapshots. Always 
cross-reference a KI's API patterns, file paths, and config values against the 
*current* source on disk before acting on them. KIs can lag behind code.

**Close the loop: update the KI after significant changes.** When you ship a 
meaningful change (new API, config schema change, architecture shift), update 
the relevant KI via `update_file` or `update_file_section`. If no KI exists 
yet, create one with `create_file` under `knowledge/` with appropriate tags. 
A KI that isn't maintained becomes noise — which is worse than no KI.

**Use `whats_new` at session start after a gap.** If you haven't touched the 
project in a while, run `whats_new(since: "7d")` to surface recently changed 
files — including KIs updated by other agents or the user.

### Tool reference

The matrix below is grouped by intent. For each tool: when to reach for it, the most common wrong context, and the better sibling tool when wrong.

#### Find

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `search` | Natural-language keyword across KB (FTS) | Substrings, URLs, code idents | `regex_search` |
| `regex_search` | Substrings, URLs, code identifiers | Natural-language queries | `search` |
| `grep_in_file` | Substring/regex within ONE known file | Searching across files | `regex_search` |
| `bundle_search` | Need search hits + bodies in a token budget | Only need IDs | `search` |
| `find_related` | Discover siblings via tag overlap | Text content matching | `search` |
| `suggest_tags` | Propose tags for an existing file | Finding files by tag | `find_related` |

#### Read

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `read_file` | One file ID, full body | ≥2 file IDs | `read_files` |
| `read_files` | 2–200 file IDs in one call | Only need a section of one file | `read_section` |
| `read_file_by_path` | Known absolute path, no ID handy | You already have the ID | `read_file` |
| `read_file_lines` | Known line range | Guessing line numbers | `read_section` |
| `read_section` | Known heading | Need the whole file | `read_file` |
| `read_file_outline` | Triaging an unfamiliar file's structure | Structure already known | `describe_file` |
| `describe_file` | Metadata only (size, tags, mtime) | Need content | `read_file` |
| `get_profile` | Read user profile/context at session start | Reading normal files | `read_file` |

#### Write

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `create_file` | One new file (md or mmd via `format`) | Bulk-creating ≥2 files | `create_files` |
| `create_files` | 2+ new files in one call | Single file | `create_file` |
| `update_file` | Replacing the whole body | Editing one section | `update_file_section` |
| `update_file_section` | Surgical edit at a known heading | Replacing the whole file | `update_file` |
| `delete_file` | One file | Bulk delete | `delete_files` |
| `delete_files` | 2+ files in one call | Single file | `delete_file` |
| `move_file` | Rename or relocate a file | File content needs changing | `update_file` |

#### Organize

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `add_tags` | Tag an existing file | Tagging at creation time | `create_file` (with `tags` param) |
| `remove_tags` | Untag a file | Want to delete the file | `delete_file` |
| `list_tags` | Enumerate all tags in the vault | Want files for a given tag | `find_related` |
| `set_favorite` | Pin / unpin a file | Semantic categorization | `add_tags` |
| `tag_search_results` | Bulk-tag every hit from a search | Tagging a single file | `add_tags` |
| `journal_note` | Log a decision, workaround, or abandonment | Editing regular content | `update_file` |
| `journal_intent` | Record a user-initiated topic pivot | Auto-captured tool calls | `journal_note` |
| `journal_append` | Append timestamped text to today's daily KB journal file | Structured notes | `journal_note` |
| `distill_journal` | Summarize accumulated journal events | Individual events | `journal_note` |
| `clip_url` | Capture a web URL into the KB | Saving a local file | `create_file` |
| `list_folders` | Enumerate folders in the project | Finding files | `list_files` |
| `create_folder` | Create a new (possibly nested) folder | Files don't need explicit folders | |
| `delete_folder` | Remove an empty folder | Folder still has files | `delete_files` first |

#### History & recovery

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `get_history` | List a file's revisions | Want a diff between two revisions | `get_diff` |
| `get_diff` | Compare two specific revisions | Want full content of one | `restore_file` |
| `restore_file` | Roll back a KB file to an earlier revision | Want to use raw `git` | |
| `diff_against_disk` | Find drift after raw filesystem edits | Normal search staleness | `refresh_index` |
| `refresh_index` | Rescan after out-of-band changes | Normal in-app edits | |
| `commit_backup` | Push KB changes to remote git | Local-only work | |

#### Discover

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `list_projects` | Enumerate registered projects | Files within one project | `list_files` |
| `list_files` | Files in a project (filterable) | Full-text content matters | `search` |
| `project_map` | Folder/file tree for a project | Flat file list | `list_files` |
| `stats` | Counts and health for a project | Per-file detail | `describe_file` |
| `whats_new` | Files added/changed since a cutoff | Full-text search | `search` |

#### Hands (project tools)

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `list_hands` | Enumerate Hands tools available in this project | Want the YAML schema | `describe_hands_schema` |
| `describe_hands_schema` | Explain the `hands.yaml` format | Listing tools | `list_hands` |
| `confirm_hand` | Approve a Hands token within 60s of issue | Normal MCP tool calls | |
| `reload_hands` | Re-read `hands.yaml` after editing it | First-time use (auto-loads) | |

#### Onboarding

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `register_project` | Register a new project root with kontexta | Already registered | `list_projects` |
| `onboard_agent` | Write/update the rules block in CLAUDE.md / AGENTS.md / etc. | Editing regular project content | `update_file` |
| `transfer_agent_context` | Copy CLAUDE.md / AGENTS.md / `.cursor/rules/*.mdc` etc. from the project repo into Kontexta's KB. Originals are NEVER deleted by this tool. | User wants files to stay in the repo (default) | `register_project` (which keeps files in place) |
<!-- END kontexta:rules v{{VERSION}} -->
