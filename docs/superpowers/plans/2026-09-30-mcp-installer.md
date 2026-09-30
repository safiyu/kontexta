# MCP installer — implementation plan (Phase 1)

Spec: docs/superpowers/specs/2026-09-30-mcp-installer-design.md. Executed natively, TDD, one review at the end. Approved decisions: user-level only, Claude Code via `claude mcp add`, Codex/Copilot/Antigravity deferred, `safe` level included.

## Rulings
- CLI is `kontexta connect <install|uninstall|status|reconcile|approval>`: `kontexta mcp` already starts the MCP server, so `kontexta mcp install` would be ambiguous.
- Phase 1 agents: claude-code, claude-desktop, cursor, gemini, cline, continue, hermes. Antigravity waits for its MCP registration path (its allowlist shape is recorded in the spec).
- Dead-file guard: an installer refuses when the agent's config folder does not exist (`~/.cline`, `~/.cursor`, …) instead of inventing a config nothing reads.
- Rule ownership: any allow rule for the `kxta` server (`mcp(kxta/…)`, `mcp__kxta…`, Cline `alwaysAllow`) is managed by us; approval `prompt` leaves existing rules alone unless the previous approval was safe/all (then they are removed); uninstall removes them.
- Tool list for `safe`/`all` comes from a generated `tools.generated.json` in core (written by `apps/mcp/scripts/generate-manifest.js`), with an MCP-side drift test against the live manifest.
- Web snippets stay in `install-templates.ts`; a drift test pins them to `buildServerEntry` instead of a refactor.
- Reconcile (incl. `kontexta start`) only refreshes registrations we installed (`mcp_installed`); first-time registration is always explicit, so a user's hand-written `kxta` entry is never replaced silently.
- No MCP-server nudges (`hooks` block / `onboard_agent mcp:true`): a session reading them is already connected through MCP; alerts live in the dashboard and CLI.
- `mcp_version` in the `agents` table stores a signature of entry+approval+tool list; reconcile reinstalls on mismatch.

## Tasks
1. **Core data**: migration 012 (`mcp_supported`, `mcp_installed`, `mcp_version`, `mcp_installed_at`, `mcp_approval`), `mcpInstallable` flag in `agents.ts`, registry fields + `markMcpInstalled/Uninstalled/setMcpApproval`, `tools.generated.json` + generator step.
2. **Entry builder** `buildServerEntry` (docker/npm/source, env rules, absolute commands for GUI agents).
3. **Installers** under `packages/core/src/mcp-install/installers/`: JSON family (claude-desktop, cursor, cline, gemini + approval rules), claude-code (shell-out, injectable runner, `~/.claude/settings.json` allow rules), continue (own YAML file), hermes (yaml doc, always sets env).
4. **Orchestrator** `installMcp/uninstallMcp/mcpStatus/reconcileMcp` + alerts + exports.
5. **MCP/CLI surface**: `connect-cli.ts` (bundle entry), `kontexta connect` dispatch, Docker entrypoint, `hooks` block MCP alerts, `admin.onboard_agent` `mcp:true`.
6. **Web**: `/api/agents` fields, `/api/agents/[id]/mcp`, Agents panel (install/uninstall + approval picker with destructive disclosure), wizard step, banner.
7. **Docs + verify**: docs/MCP.md, HOOKS.md cross-link, full suites, typecheck, packed-bundle end-to-end.
