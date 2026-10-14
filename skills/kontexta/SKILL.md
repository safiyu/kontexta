---
name: kontexta
description: Access the user's Kontexta (kxta) knowledge base, journal, calendar, projects and Hands via a local bridge to the kxta MCP server. Use whenever the user mentions kxta/Kontexta, their notes/KB, journal, profile, calendar events, or when CLAUDE.md / KONTEXTA.md rules reference kxta tools that are not natively available in this session.
---

# Kontexta (kxta) bridge

Use this when the kxta MCP tools are not loaded natively in the session (e.g. MCP is disabled by policy). Every kxta tool named in CLAUDE.md / KONTEXTA.md (or as `mcp__kxta__<tool>`) maps to `call <tool>`. Follow those rules exactly as written, just with this invocation. If native `mcp__kxta__*` tools are available, use them instead.

```bash
K=~/.claude/skills/kontexta/scripts/kxta.py
python3 $K context                      # session context (= MCP instructions: profile, events, nudges)
python3 $K list                         # tool names + short descriptions
python3 $K rules                        # markdown snippet to append to CLAUDE.md (bridge prefix + tool list)
python3 $K schema <tool>                # full input schema for one tool
python3 $K call <tool> '<json-args>'    # invoke one tool
python3 $K batch                        # many calls in one process (JSONL on stdin)
python3 $K stop                         # shut down the background server
```

If the skill is installed per project instead, the script lives at `.claude/skills/kontexta/scripts/kxta.py`. On Windows, use `python` (or `py -3`) if `python3` isn't available.

Long or quote-heavy arguments: pass `-` and pipe JSON on stdin:

```bash
python3 ~/.claude/skills/kontexta/scripts/kxta.py call journal_write - <<'EOF'
{"kind": "note", "text": "...", "tags": ["..."]}
EOF
```

## Loops and repeated calls

A background daemon (one per working directory) keeps a single kxta server alive between calls, so repeated and looped calls are cheap (~0.1s each after the cold start) and share server state. It exits after 30 min idle (`KXTA_IDLE_SECONDS`).

- Many independent calls: prefer `batch` over a shell loop. Input is one `{"tool": "...", "args": {...}}` per line; output is one `{"tool", "isError", "text"}` per line, in order. A failing item doesn't stop the batch; exit code is 1 if any item failed.
  ```bash
  printf '%s\n' '{"tool":"files_describe","args":{"id":12}}' '{"tool":"files_describe","args":{"id":15}}' | python3 ~/.claude/skills/kontexta/scripts/kxta.py batch
  ```
- Shell loops and parallel calls also work (calls are serialized safely inside the daemon).
- Still prefer the tools' own batch params where they exist (`files_read` with `ids`, `files_create` with `files`, `files_delete` with `ids`), per the KONTEXTA.md "don't loop `files_read`" rule.

## Rule-specific notes

- **Session start:** "call `admin_refresh_session_context` on turn 1" → `call admin_refresh_session_context`. `context` returns the same block.
- **Hands:** approval tokens live in the daemon's memory, so `hands_confirm` works as long as it's called within 60s from the same working directory. Don't run `stop` between a Hands call and its confirm.
- **`journal` envelope:** tool responses may carry `journal.suggested_action`; act on it as the rules say. `journal_bypass: true` (strict mode) is passed inside the tool's JSON args.
- **Project scope:** the daemon starts the server in the current working directory (override with `KXTA_CWD`), so run calls from the project root.
- Run `schema <tool>` before first use of a tool whose arguments you don't already know; don't guess parameter names.
- Tools described as DESTRUCTIVE or SIDE-EFFECTFUL (`files_delete`, `folders_delete`, `files_restore`, `admin_commit_backup`, `calendar_entities_delete`, `hands_confirm`, ...) need the same user confirmation as native tools.
- Exit code 1 = tool error (text printed). If the daemon fails to start, check that `npx -y --package=kontexta@latest kontexta mcp` runs on its own (Node 22+), or set `KXTA_SERVER`.
- `KXTA_SERVER` selects the server: a `.js` entrypoint (run with `node`) or a full command line. Default: `npx -y --package=kontexta@latest kontexta mcp`. After changing it or upgrading kontexta, run `stop` so the next call starts the new server.
