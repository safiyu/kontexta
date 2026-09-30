<!--
Compact kontexta rules stub — injected into agent context files
(CLAUDE.md, GEMINI.md, AGENTS.md, .cursor/rules/kontexta.mdc, etc.).

The full reference (tool routing matrix, KI workflow, content class) lives in
rules-reference.md and is written to KONTEXTA.md at the project root by
syncAgentRules(). This stub is kept small to minimize per-turn token cost.

The placeholder {{VERSION}} is substituted at module init with RULE_BLOCK_VERSION.
-->
<!-- BEGIN kontexta:rules v{{VERSION}} -->
## Working with kontexta

This project uses kontexta for context, knowledge, and journal management. Tools live under the `kxta` MCP server.

**Core constraints:**
- **Session start:** Call `admin.refresh_session_context` on turn 1; print a 1–3 line greeting (date, profile, conflicts). Skip if the user's first message is a task.
- **User profile:** Call `admin.get_profile` to read user context, role, preferences, and goals.
- **All KB writes go through kontexta.** Use `files.create` / `files.update` / `journal.write`. Never edit KB files with raw filesystem tools. Never write context artifacts (diagrams, specs, notes, `.mmd` files) directly into the project repo — use `files.create` with `destination: "knowledge"`.
- **Search before reading.** Use `files.search` or `files.regex_search` first, not `files.read` on a guessed path.
- **Act on `journal.suggested_action`** before your next tool call, or pass `journal_acknowledge: true` to dismiss.
- **Tag new KB files** at creation time via `tags` on `files.create` or `tags.add`.
- **Use `.mmd` for diagrams** via `files.create` with `format: "mmd"`, `destination: "knowledge"`. Never fenced mermaid in `.md`, never `.mmd` files in the project repo.
- **Confirm Hands tokens within 60 seconds.** Tokens expire.
- **Log decisions** with `journal.write({kind: "note"})` and **topic pivots** with `journal.write({kind: "intent"})`.
- **Relay `hooks` prompts** once per session when present in tool responses.

**Strict folder structure in Knowledge Base:**
All context artifacts must strictly follow this folder hierarchy inside the Knowledge Base (`destination: "knowledge"`):
- **HTML reports:** `html/` (use `files.create` with `format: "html"`, `destination: "knowledge"`)
- **Mermaid diagrams (`.mmd`):** `mermaid/` (use `files.create` with `format: "mmd"`, `destination: "knowledge"`)
- **Journals:** `journal/` (managed via `journal.write` / `journal.distill`)
- **Knowledge Base files:** `knowledge/dictionary/` (`kind: "dictionary"` for sources of truth) or `knowledge/notes/` (`kind: "note"` for working notes & snapshots)
Never write context or diagram files directly into the project repository.

**Full rules, tool routing matrix, and workflow guidance:** See [KONTEXTA.md](./KONTEXTA.md).
<!-- END kontexta:rules v{{VERSION}} -->
