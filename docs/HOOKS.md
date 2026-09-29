# Agent hooks — conversation capture

Kontexta's journal records what happens through its own MCP tools. Hooks add the part MCP can't see: **what you asked, what the agent asked back and replied, and which shell commands it ran**. File paths, edits and reads are deliberately *not* captured by hooks — git history and the MCP capture already have them.

## How it works

1. You enable an agent (dashboard → Settings → Agents, the first-run wizard, or `kontexta hooks enable <agent>`). Every agent starts **disabled**; nothing is installed for an agent you haven't enabled.
2. Kontexta writes hook entries into that agent's user-level config and stages a dependency-free script at `<data dir>/hooks/emit.mjs`.
3. On each prompt, reply and shell command the agent runs `node emit.mjs --agent <id>`; the script appends one JSON line to `<data dir>/knowledge/journal/<project>/raw/<date>.jsonl`. It prints nothing and always exits 0, so it can never block a turn.
4. `journal.distill` renders a **Conversation** and a **Shell** section per task; `files.search` finds them.

The project is resolved from the agent's working directory via `<data dir>/hooks/projects.json`; the git branch is read from `.git/HEAD` so entries bucket by branch even without the MCP server running.

## What is captured

| Event | Kept | Cap (bytes, configurable) |
|---|---|---|
| Your prompt | verbatim | 8192 |
| Agent reply (end of turn) | verbatim | 4096 |
| Agent question + your answer | verbatim | — |
| Shell command | command line only — no output, no exit code | 2048 |
| Branch | current branch name | — |

Secrets are scrubbed before writing: object keys matching `password|token|secret|auth|cookie|bearer|api[_-]?key`, and values such as `--password=…` / `TOKEN=…` assignments, `curl -u user:pass`, `scheme://user:pass@host`, `Bearer`/`Basic` credentials, JWTs, PEM private keys and common provider tokens (GitHub, GitLab, Google, OpenAI, Stripe, Slack, AWS, npm, Hugging Face) become `<redacted>`. Redaction is pattern-based and best-effort: a bare password typed into a sentence without `password is`/`=`/`:` next to it (or a `mysql -pSECRET` flag) is not caught.

Caps live in `<data dir>/kontexta.json`:
```json
{ "journal": { "hooks": { "prompt_max_bytes": 8192, "reply_max_bytes": 4096, "command_max_bytes": 2048 } } }
```

## Per-agent capabilities (verified 2026-09-29)

| Agent | Config written | Prompt | Reply | Q&A | Shell | Known limitations |
|---|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | ✓ | ✓ (incl. subagents) | ✓ | ✓ | — |
| Gemini CLI | `~/.gemini/settings.json` | ✓ | ✓ | ✗ | ✓ | No question tool exposed to hooks. |
| Codex CLI | `~/.codex/hooks.json` | ✓ | ✓ | ✗ | ✓ | Codex only runs hooks you have trusted: run `/hooks` in Codex to review and trust them, and re-trust after a reinstall. Older versions may also need `codex_hooks = true` in `~/.codex/config.toml`. |
| GitHub Copilot CLI | `~/.copilot/hooks/kontexta.json` (or `$COPILOT_HOME/hooks/`) | ✓ | subagents only | ✗ | ✓ | Main-agent `agentStop` exposes no message text yet. Verified against GitHub's hooks reference (2026-09-29). Windows uses the same file (`command` is cross-platform). |
| Cursor | `~/.cursor/hooks.json` | ✓ | ✓ (per message) | ✗ | ✓ | Replies arrive per assistant message, not per turn. |
| Windsurf | `~/.codeium/windsurf/hooks.json` | ✓ | ✓ | ✗ | ✓ | Payload has no event name; kontexta passes `--event`. Docs were unreachable at verification time — medium-low confidence. |
| Kiro | not supported | ✗ | ✗ | ✗ | ✗ | See [Not supported](#not-supported). MCP capture only. |
| Cline | `~/Documents/Cline/Hooks/{UserPromptSubmit,PostToolUse}` | ✓ | ✗ | ✗ | ✓ | No turn-end hook exists yet. Existing non-kontexta hook files are never overwritten. |
| OpenCode | `~/.config/opencode/plugins/kontexta.ts` | ✓ | ✗ | ✗ | ✓ | Replies are not exposed to plugins. |
| Claude Desktop, Antigravity, Continue, Aider, Hermes | — | ✗ | ✗ | ✗ | ✗ | No hook API. MCP capture only. |

### Not supported

- **Kiro** — its hooks exist only inside a custom agent's config (`~/.kiro/agents/*.json`, `hooks` key) and Kiro CLI does not currently run them in interactive sessions ([kirodotdev/Kiro#11620](https://github.com/kirodotdev/Kiro/issues/11620), checked 2026-09-29), so an installer would report success and capture nothing. Kiro stays MCP-only. `emit.mjs` still contains a Kiro adapter, ready for when that is fixed and an installer can be written.

When an agent ships a missing capability, update its adapter in `packages/core/src/hooks/emit.mjs`, add a fixture under `packages/core/tests/hooks/fixtures/<agent>/`, and update this table.

## Install paths

- **npx** — `npx kontexta start` reconciles on every start: enabled agents that are missing hooks (or have a stale emitter) get installed. Enabling an agent in the dashboard installs immediately.
- **Docker** — the container cannot edit files in your home directory, so the dashboard shows a one-liner per enabled agent that runs the installer in a throw-away container with your home mounted:
  ```bash
  docker run --rm -v "$HOME":/host -v "<DATA_DIR>":/app/data safiyu/kontexta:<version> hooks install --home /host --host-data-dir "<DATA_DIR>" --no-db --agent <agent>
  ```
  Replace `<DATA_DIR>` with the **absolute** host path of your data folder (a relative path such as compose's `./kontexta-data` default would break, because hooks run from each project's directory). `--host-data-dir` is the path baked into the agent's config (the host path); the container keeps using `/app/data` for staging. `--no-db` keeps the installer from opening the SQLite file the dashboard container is using; the dashboard learns the hooks work when the first event arrives (the agent shows as **verified**). `node` must be on the host `PATH` for the emitter to run.
- **Source** — `kontexta hooks status|install|uninstall|enable|disable|reconcile` (nothing is automatic).

Hooks are written into the home directory of the process that installs them. Set `KONTEXTA_HOOKS_HOME` to point the dashboard or the MCP server at a different home (for example when the MCP server runs in a container or over SSH).

Installed hook commands use the absolute path of the `node` that installed them, because editors launched from the Dock or Start menu do not inherit your shell `PATH`. If you move or upgrade node, re-run `kontexta hooks install --agent <id>` to refresh the path.

Disabling an agent stops alerts and hides it from the configure section but leaves the hook config in place; `kontexta hooks uninstall --agent <id>` removes only the entries kontexta wrote and turns the agent off (turn it back on to reinstall).

## Managing agents

- **First-run wizard** (`/?setup=1` after you set the security key): pick your agents → hooks are installed for them (Docker shows the host command instead) → profile → onboard an agent.
- **Configure → AGENTS** tab: a switch per agent. Turning one on installs its hooks immediately (outside Docker); turning it off keeps the config in place. *Uninstall* removes only kontexta's entries. The MCP SERVER CONFIG tab lists only enabled agents (plus Generic JSON).
- **Banner:** shown when an enabled agent has no hooks (or none has reported an event for over a week). It links to the AGENTS tab and can be dismissed for the session.
- **From an agent:** `projects.register`, `admin.onboard_agent` and the session welcome mention hooks when an enabled agent needs them. After you agree, `admin.onboard_agent({ project_id, confirm: true, target_agent: "<id>", hooks: true })` enables that agent and installs its hooks (Docker installs get the host command back).

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `KONTEXTA_HOOKS_HOME` | dashboard, MCP server, `kontexta hooks` | Home directory to write agent configs into instead of the current user's (containers, SSH). |
| `KONTEXTA_NO_HOOKS` | `kontexta start` | Set to `1` to skip the hook reconcile on start. |
| `KONTEXTA_HOOK_STDIN_TIMEOUT_MS` | `emit.mjs` | How long the emitter waits for the agent's payload before giving up (default 5000). |
| `KONTEXTA_HOST_DATA_DIR` | dashboard, MCP server (Docker) | Host path of the data folder, used to build the Docker install command. |

## Verifying

`kontexta hooks status` shows, per agent: enabled, installed (with emitter version), and **verified** — the first time a hook event actually arrives. `kontexta doctor` reports the staged emitter version.
