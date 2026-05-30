# Kontexta Journaling System

Kontexta's journaling system acts as a seamless memory engine that records the "why" and "how" of your project's evolution, automatically capturing context across different agents (like Claude Code, Cursor, Aider, and Continue).

The journal captures every tool call an agent makes, distilling the raw data into structured, topic-based markdown files in your knowledge base. This guarantees that when you switch agents or hand off a task, the new agent starts with the exact architectural state and context of the previous one.

## Journal Modes

You can control how strictly Kontexta enforces this journaling via the **Journal Config** panel in the Web UI. There are three modes:

### 1. `lenient` (Recommended Default)
In lenient mode, Kontexta is unobtrusive. It never blocks an agent from working.
- If there are undistilled raw events in the backlog, it injects a subtle "nag" envelope into the tool responses, suggesting the agent call `distill_journal`.
- If the backlog grows too large (e.g., > 500 events or > 7 days old), the MCP server will run a fast, mechanical distillation automatically in the background to ensure memory isn't lost.

### 2. `strict`
Strict mode forces agents to maintain a clean journal before they are allowed to read new information.
- It **blocks all read tools** (`search`, `read_file`, `list_files`, etc.) with a `JOURNAL_BACKLOG` error if there are undistilled events pending.
- Write tools and journaling tools remain unaffected.
- This forces the agent to stop and run `distill_journal` to summarize its recent work before moving on to new files.
- You can override this on a per-call basis by passing `journal_bypass: true` in the tool arguments (which is logged for audit purposes).

### 3. `mechanical-only`
This mode operates similarly to lenient, but it instructs agents **not** to attempt upgrading the quick, mechanical markdown summaries into richer LLM-narrative summaries. This is useful for large projects where you want raw logs categorized but don't want to spend LLM tokens summarizing them deeply.

## Retention and Housekeeping

The journal config also lets you define retention policies to keep your knowledge vault lean:

- **`raw_days`**: How long to keep the raw, low-level JSONL events (default: 90 days).
- **`mechanical_only_days`**: How long to keep basic, mechanical markdown summaries (default: 365 days).
- **`archive_cold_after_days`**: Automatically archive inactive task/topic summaries.
- **`purge_archived_after_days`**: Permanently delete archived items. Setting these to `0` means they are kept forever.

## WebUI Scheduler

If you leave the Next.js dashboard running, you can enable the **WebUI Scheduler**. This will automatically run mechanical distillation and retention housekeeping on a fixed schedule (e.g., every 15 minutes and 24 hours), meaning your agents never have to waste tokens managing the journal themselves.
