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

**Print the session welcome as your first message.** On the very first turn of any new session, call `admin.refresh_session_context` and print a brief greeting to the user based on what it returns — today's date, their name from the profile, upcoming events / conflicts if any, a nudge if the profile is empty or stale. 1–3 lines, not a report. Two reasons: (1) if the client lazy-loads MCP servers, this is what actually triggers `initialize`; (2) the user sees kontexta is connected and knows what context you have. Skip if the user's first message is already a work request — do the work.

**Search before reading.** Use `files.search`, `files.bundle_search`, or `files.regex_search` to find context first. Skipping straight to `files.read` on a guessed path wastes tokens and often misses the right file.

**All KB writes go through kontexta.** Use `files.create` / `files.update` / `files.update_section` / `journal.note`. **Never** edit a KB file with raw filesystem tools (Edit/Write/cat) — the watcher and FTS index will diverge until `projects.refresh_index` runs, and subsequent searches will return stale results.

**Batch reads. Don't loop `files.read`.** Need ≥2 files? Call `files.read_many` (one round-trip, up to 200 IDs) or `files.bundle_search` (token-budgeted blob). Looping `files.read` wastes round-trips and inflates response overhead.

**Address `journal.suggested_action` before the next tool call.** Many tool responses include a `journal` envelope. If `journal.suggested_action` is set (e.g., `"journal.distill"`), call that tool before issuing your next tool. To dismiss for the rest of the session, pass `journal_acknowledge: true` on your next tool call.

**Use `journal.note(text, tags)` for decisions and abandonments.** When you make a non-obvious call, try something that doesn't work, or capture a workaround, log it. Hands runs are auto-captured now.

**Use `journal.intent(summary)` when the user pivots.** One short sentence so the distillation step knows the topic shifted.

**Strict mode awareness.** If a project sets `journal.mode = "strict"` in its `kontexta.json`, the MCP server returns a `JOURNAL_BACKLOG` error on read tools (search/read_*/list_*) when undistilled events exist. The error includes `next_action: "journal.distill"`. Either run `journal.distill` first, OR pass `journal_bypass: true` on the read call to override (logged for audit).

**Confirm Hands tokens within 60 seconds.** When a Hands tool returns an approval token, do NOT chain a long question or another tool call before `hands.confirm`. Tokens expire; the user will have to re-issue the whole flow.

**Save specs to a canonical location.** When generating a spec, plan, or design doc, write it to the KB at `specs/<project-name>/<spec-name>.md` (use `files.create` with `destination: "knowledge"`, `folder: "specs/<project-name>"`). One folder per project keeps specs queryable.

**Tag new KB files at creation time.** Pass `tags` on `files.create`, or call `tags.add` immediately after. Untagged files are recoverable but invisible to `files.find_related`.

**`admin.whats_new` early. `admin.commit_backup` late.** Run `admin.whats_new` at session start if you've been away — it returns files added/changed since a cutoff. End the session with `admin.commit_backup` if you mutated KB files and the project has a remote.

**Use `.mmd` for diagrams, not fenced code in `.md`.** When creating an architecture / flow / sequence diagram, call `files.create` with `format: "mmd"` and put the raw mermaid source as the body (no ```` ```mermaid ```` fence). The web UI renders `.mmd` files as live diagrams with SVG/PNG export; mermaid embedded in markdown is just text. Default folder: `mermaid/` (or `<project>/mermaid/` for project-scoped diagrams).


### Knowledge Items (KI)

KIs are curated, distilled KB files — the highest-signal context in the vault. 
They save tokens and prevent redundant research when used correctly.

**Check KIs before independent research.** At the start of any task, run 
`files.search` or `files.bundle_search` over the KB for the task topic. If a matching KI 
exists, read it before writing code, designing architecture, or forming a plan. 
Skipping this step is the single most common source of duplicated work.

**KIs are starting points, not ground truth.** KIs are snapshots. Always 
cross-reference a KI's API patterns, file paths, and config values against the 
*current* source on disk before acting on them. KIs can lag behind code.

**Close the loop: update the KI after significant changes.** When you ship a 
meaningful change (new API, config schema change, architecture shift), update 
the relevant KI via `files.update` or `files.update_section`. If no KI exists 
yet, create one with `files.create` under `knowledge/` with appropriate tags. 
A KI that isn't maintained becomes noise — which is worse than no KI.

**Use `admin.whats_new` at session start after a gap.** If you haven't touched the 
project in a while, run `whats_new(since: "7d")` to surface recently changed 
files — including KIs updated by other agents or the user.

### Content class

`files.create` / `files.create_many` require `kind` for KB writes:
- **`dictionary`** = source of truth (mappings, glossaries, runbooks, PR templates, architecture docs)
- **`note`** = snapshot (meeting notes, PR findings, sprint reviews, post-mortems, working thoughts)

Test: *if this file disagreed with the code, who wins?* File wins → dictionary; file loses → note. Search ranks dictionary hits above everything else; filter with `kind` on any read tool for one class. `journal`/`project` are auto-assigned — don't pass them to `files.create`.

### Tool reference

The matrix below is grouped by intent. For each tool: when to reach for it, the most common wrong context, and the better sibling tool when wrong.

#### Find

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `files.search` | Natural-language keyword across KB (FTS) | Substrings, URLs, code idents | `files.regex_search` |
| `files.regex_search` | Substrings, URLs, code identifiers | Natural-language queries | `files.search` |
| `files.grep` | Substring/regex within ONE known file | Searching across files | `files.regex_search` |
| `files.bundle_search` | Need search hits + bodies in a token budget | Only need IDs | `files.search` |
| `files.find_related` | Discover siblings via tag overlap | Text content matching | `files.search` |
| `tags.suggest` | Propose tags for an existing file | Finding files by tag | `files.find_related` |

#### Read

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `files.read` | One file ID, full body | ≥2 file IDs | `files.read_many` |
| `files.read_many` | 2–200 file IDs in one call | Only need a section of one file | `files.read_section` |
| `files.read_by_path` | Known absolute path, no ID handy | You already have the ID | `files.read` |
| `files.read_lines` | Known line range | Guessing line numbers | `files.read_section` |
| `files.read_section` | Known heading | Need the whole file | `files.read` |
| `files.read_outline` | Triaging an unfamiliar file's structure | Structure already known | `files.describe` |
| `files.describe` | Metadata only (size, tags, mtime) | Need content | `files.read` |
| `admin.get_profile` | Read user profile/context at session start | Reading normal files | `files.read` |

#### Write

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `files.create` | One new file (md, mmd, or html via `format`) | Bulk-creating ≥2 files | `files.create_many` |
| `files.create_many` | 2+ new files in one call | Single file | `files.create` |
| `files.update` | Replacing the whole body | Editing one section | `files.update_section` |
| `files.update_section` | Surgical edit at a known heading | Replacing the whole file | `files.update` |
| `files.delete` | One file | Bulk delete | `files.delete_many` |
| `files.delete_many` | 2+ files in one call | Single file | `files.delete` |
| `files.move` | Rename or relocate a file | File content needs changing | `files.update` |

#### Organize

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `tags.add` | Tag an existing file | Tagging at creation time | `files.create` (with `tags` param) |
| `tags.remove` | Untag a file | Want to delete the file | `files.delete` |
| `tags.list` | Enumerate all tags in the vault | Want files for a given tag | `files.find_related` |
| `tags.set_favorite` | Pin / unpin a file | Semantic categorization | `tags.add` |
| `tags.search` | Bulk-tag every hit from a search | Tagging a single file | `tags.add` |
| `journal.note` | Log a decision, workaround, or abandonment | Editing regular content | `files.update` |
| `journal.intent` | Record a user-initiated topic pivot | Auto-captured tool calls | `journal.note` |
| `journal.append` | Append timestamped text to today's daily KB journal file | Structured notes | `journal.note` |
| `journal.distill` | Summarize accumulated journal events | Individual events | `journal.note` |
| `journal.status` | Check backlog size and high-water mark before distilling | Need the raw events themselves | `journal.distill` |
| `journal.commit_upgrades` | Mark journal entries upgraded after a subagent rewrites them | Running the initial distillation | `journal.distill` |
| `journal.housekeep` | Prune old raw journal files and archive cold tasks | Need to distill new events first | `journal.distill` |
| `resources.clip_url` | Capture a web URL into the KB | Saving a local file | `files.create` |
| `folders.list` | Enumerate folders in the project | Finding files | `files.list` |
| `folders.create` | Create a new (possibly nested) folder | Files don't need explicit folders | |
| `folders.delete` | Remove an empty folder | Folder still has files | `files.delete_many` first |

#### Reports

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `resources.add_report` | Add an image to the shared `reports/resources/` pool | Embedding data URIs | |
| `resources.list_reports` | List all shared report resources | Need full file list | `files.list` |
| `resources.delete_report` | Delete a shared resource by name | Deleting a report file | `files.delete` |
| `resources.export_report` | Export an HTML report as PDF or PNG | Exporting markdown | |

#### History & recovery

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `files.get_history` | List a file's revisions | Want a diff between two revisions | `files.get_diff` |
| `files.get_diff` | Compare two specific revisions | Want full content of one | `files.restore` |
| `files.restore` | Roll back a KB file to an earlier revision | Want to use raw `git` | |
| `files.diff_against_disk` | Find drift after raw filesystem edits | Normal search staleness | `projects.refresh_index` |
| `projects.refresh_index` | Rescan after out-of-band changes | Normal in-app edits | |
| `admin.commit_backup` | Push KB changes to remote git | Local-only work | |

#### Discover

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `projects.list` | Enumerate registered projects | Files within one project | `files.list` |
| `files.list` | Files in a project (filterable) | Full-text content matters | `files.search` |
| `projects.map` | Folder/file tree for a project | Flat file list | `files.list` |
| `admin.stats` | Counts and health for a project | Per-file detail | `files.describe` |
| `admin.whats_new` | Files added/changed since a cutoff | Full-text search | `files.search` |
| `admin.refresh_session_context` | Re-fetch profile + upcoming events after mid-session edits | Reading a single profile field | `admin.get_profile` |

#### Calendar

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `calendar.entities.add` | Register a new thing to track (server, vehicle, location, etc.) | Entity already exists | `calendar.entities.update` |
| `calendar.entities.update` | Rename, retag, or retire (`active:false`) an entity | Entity doesn't exist yet | `calendar.entities.add` |
| `calendar.entities.delete` | Permanently remove an entity, cascading its events/links | Just want to stop scheduling against it | `calendar.entities.update` |
| `calendar.entities.list` | Enumerate entities with their dependency links | Need conflict or event data | `calendar.events.conflicts` |
| `calendar.entities.link` | Record or remove a dependency edge for conflict detection | Want to see existing links | `calendar.entities.list` |
| `calendar.events.add` | Schedule a one-off event (downtime, maintenance, delivery, etc.) | Editing an existing event | `calendar.events.update` |
| `calendar.events.update` | Move, retitle, or re-home an existing event | Event doesn't exist yet | `calendar.events.add` |
| `calendar.events.delete` | Remove one event permanently | Want to just move it | `calendar.events.update` |
| `calendar.events.list` | List/filter events in a time window | Only need the conflict report | `calendar.events.conflicts` |
| `calendar.events.conflicts` | Find overlapping or too-close-together events in a window | Just need the raw event list | `calendar.events.list` |
| `calendar.export_ics` | Export a window as an ICS file for calendar apps | Need machine-readable event data | `calendar.events.list` |

#### Hands (project tools)

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `hands.list` | Enumerate Hands tools available in this project | Want the YAML schema | `hands.describe_schema` |
| `hands.describe_schema` | Explain the `hands.yaml` format | Listing tools | `hands.list` |
| `hands.confirm` | Approve a Hands token within 60s of issue | Normal MCP tool calls | |
| `hands.reload` | Re-read `hands.yaml` after editing it | First-time use (auto-loads) | |

#### Onboarding

| Tool | When | Not when | Use instead |
|---|---|---|---|
| `projects.register` | Register a new project root with kontexta | Already registered | `projects.list` |
| `admin.onboard_agent` | Write/update the rules block in CLAUDE.md / AGENTS.md / etc. | Editing regular project content | `files.update` |
| `admin.transfer_agent_context` | Copy CLAUDE.md / AGENTS.md / `.cursor/rules/*.mdc` etc. from the project repo into Kontexta's KB. Originals are NEVER deleted by this tool. | User wants files to stay in the repo (default) | `projects.register` (which keeps files in place) |
<!-- END kontexta:rules v{{VERSION}} -->
