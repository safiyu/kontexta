# kontexta skill: kxta without MCP

An agent skill that gives Claude Code (and any agent that can run shell commands) the full kxta toolset when MCP servers can't be used, e.g. on managed/enterprise installs where user-added MCP servers are blocked.

`scripts/kxta.py` is a small, dependency-free MCP client: it starts the kxta server in a background daemon and exposes every tool as `kxta.py call <tool> '<json>'`. Looped, parallel and batched calls share one server process, so Hands confirmations and other per-session state work as they do over native MCP.

## Requirements

- Python 3.8+ (standard library only)
- Node 22+ (the default server is `npx -y --package=kontexta@latest kontexta mcp`)
- macOS, Linux or Windows. The daemon listens on a random `127.0.0.1` port and requires a per-daemon token kept in a user-only state file (`~/.cache/kxta/`, or `%LOCALAPPDATA%\kxta\` on Windows)

On Windows, use `python` (or `py -3`) wherever these docs say `python3`; Claude Code's Git Bash shell accepts the `~/.claude/...` paths as written.

## Install

User-wide (all projects):

```bash
mkdir -p ~/.claude/skills && cp -R skills/kontexta ~/.claude/skills/
```

Or per project, committed alongside the code:

```bash
mkdir -p .claude/skills && cp -R skills/kontexta .claude/skills/
```

Start a new Claude Code session so the skill is picked up. Then check it works:

```bash
python3 ~/.claude/skills/kontexta/scripts/kxta.py call projects_list '{}'
```

Running kontexta from source or Docker? Point `KXTA_SERVER` at it, e.g. `KXTA_SERVER=/path/to/kontexta/apps/mcp/dist/index.js`, or a full command line like `KXTA_SERVER="docker run --rm -i -v $HOME/kontexta-data:/app/data safiyu/kontexta:latest mcp"`.

## Pair it with the project rules

Teach the agent how to call every kxta tool through the bridge by appending the `rules` snippet to your project's `CLAUDE.md`:

```bash
python3 ~/.claude/skills/kontexta/scripts/kxta.py rules >> CLAUDE.md
```

The snippet starts with one line showing the bridge-prefix command, followed by the full tool list (names + one-line descriptions). It is deliberately lighter than `admin_onboard_agent`'s block, which encodes workflow rules written for native MCP tool names like `mcp__kxta__search`.

If you also want the full MCP workflow rules (search-before-read, journal conventions, etc.), run `admin_onboard_agent` separately.

## Commands

| Command | What it does |
|---|---|
| `context` | Session context (the MCP `instructions` block: profile, events, nudges) |
| `list` | Tool names with short descriptions |
| `rules` | Markdown snippet to paste or redirect into `CLAUDE.md`: one-line bridge-prefix instruction + the full tool list. Lighter than `admin_onboard_agent`'s block, which assumes native MCP |
| `schema <tool>` | Full input schema for one tool |
| `call <tool> '<json>'` | Invoke one tool (`-` reads the JSON from stdin) |
| `batch` | JSONL in (`{"tool", "args"}`), JSONL out (`{"tool", "isError", "text"}`) |
| `stop` | Shut down the background server for the current directory |

Environment: `KXTA_SERVER` (server command), `KXTA_CWD` (project directory, default cwd), `KXTA_IDLE_SECONDS` (daemon idle timeout, default 1800).

## Notes

- Calls run through the agent's shell tool, so they follow its normal permission prompts and appear in shell-capture hooks.
- If your organisation disabled MCP on purpose, check this kind of bridge is acceptable under its policy before using it.
