export const CLIENTS = [
  "claude-code", "claude-desktop", "cursor", "codex", "gemini", "antigravity", "continue", "aider", "cline", "copilot", "hermes", "generic",
] as const;
export type Client = typeof CLIENTS[number];

export const INSTALLS = ["docker", "npm", "source"] as const;
export type Install = typeof INSTALLS[number];

export interface TemplateVars {
  dataDir: string;
  hostDataDir: string | null;
  version: string;
  sourceEntrypoint: string;
  /** True when dataDir is the OS-standard default (not a user override). */
  isDefaultDir: boolean;
  /** Human-readable default path for this OS, e.g. ~/.local/share/kontexta */
  defaultDirDisplay: string;
  /** True when this dashboard was launched via `npx kontexta start`: the `kontexta` package is confirmed locally installed. */
  hasLocalCliMcp: boolean;
}

export interface Snippet {
  kind: "shell" | "json";
  body: string;
  notes: string[];
  configPath?: string;
}

// A detected local `kontexta` install (from `npx kontexta start`) beats the generic kontexta-mcp default: same server either way.
function npmArgs(vars: TemplateVars): string[] {
  return vars.hasLocalCliMcp ? ["-y", "kontexta", "mcp"] : ["-y", "kontexta-mcp"];
}
// Escape a value for a YAML double-quoted scalar (the `mcp_servers` block pasted
// into Hermes/Continue config). YAML: like JSON: treats `\` as an escape
// character, so an unescaped Windows path (C:\Users\...) is INVALID YAML (`\U`
// is read as a unicode escape) and the whole block fails to parse. The JSON
// snippets never hit this because JSON.stringify escapes for us; the hand-built
// YAML templates must escape by hand.
function yamlDq(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function npmNotes(vars: TemplateVars, install: Install): string[] {
  if (install !== "npm") return [];
  return vars.hasLocalCliMcp
    ? ["Detected a local kontexta install, using its bundled MCP server. Alternative: npx -y kontexta-mcp."]
    : ["Alternative: npx kontexta mcp (same MCP server, bundled with the one-click dashboard package)."];
}

function dataDirNote(vars: TemplateVars, install: Install): string {
  if (install === "docker") return `Data directory: ${vars.hostDataDir || vars.dataDir} (mounted into container)`;
  if (vars.isDefaultDir) return `Data directory: ${vars.defaultDirDisplay} (OS default, no override needed)`;
  return `Data directory: ${vars.dataDir} (custom, set via KONTEXTA_DATA_DIR)`;
}

function genericJson(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const hostDir = vars.hostDataDir || vars.dataDir;
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${hostDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? npmArgs(vars)
        : [vars.sourceEntrypoint];
  // For docker, always include the data dir env. For npm/source, omit it when
  // using the OS default: the MCP server auto-discovers the path from the
  // ~/.kontexta_datadir cache written by the web app.
  const env = install === "docker" || !vars.isDefaultDir
    ? { KONTEXTA_DATA_DIR: vars.dataDir }
    : undefined;
  const serverConfig: Record<string, unknown> = { command, args };
  if (env) serverConfig.env = env;
  const body = JSON.stringify({ mcpServers: { kxta: serverConfig } }, null, 2);
  return { kind: "json", body, notes: [dataDirNote(vars, install), ...npmNotes(vars, install)] };
}

function claudeCodeShell(vars: TemplateVars, install: Install): Snippet {
  const hostDir = vars.hostDataDir || vars.dataDir;
  const tail =
    install === "docker"
      ? `-- docker run --rm -i -v ${hostDir}:/app/data safiyu/kontexta:${vars.version} mcp`
      : install === "npm"
        ? `-- npx ${npmArgs(vars).join(" ")}`
        : `-- node ${vars.sourceEntrypoint}`;
  // Omit -e KONTEXTA_DATA_DIR for npm/source when using the OS default: the
  // MCP server auto-discovers the path from ~/.kontexta_datadir written by the web app.
  const envFlag = install === "docker" || !vars.isDefaultDir
    ? `\n  -e KONTEXTA_DATA_DIR=${vars.dataDir} \\`
    : "";
  return {
    kind: "shell",
    body: `claude mcp add kxta -s user \\${envFlag}\n  ${tail}`,
    notes: [dataDirNote(vars, install), ...npmNotes(vars, install)],
  };
}

// Codex keeps MCP servers in ~/.codex/config.toml ([mcp_servers.<name>]); `codex mcp add` writes it, so the snippet is a command.
function codexShell(vars: TemplateVars, install: Install): Snippet {
  const hostDir = vars.hostDataDir || vars.dataDir;
  const tail =
    install === "docker"
      ? `docker run --rm -i -v ${hostDir}:/app/data safiyu/kontexta:${vars.version} mcp`
      : install === "npm"
        ? `npx ${npmArgs(vars).join(" ")}`
        : `node ${vars.sourceEntrypoint}`;
  const envFlag = install !== "docker" && !vars.isDefaultDir ? ` --env KONTEXTA_DATA_DIR=${vars.dataDir}` : "";
  return {
    kind: "shell",
    body: `codex mcp add kxta${envFlag} -- ${tail}`,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "Codex stores MCP servers in ~/.codex/config.toml under [mcp_servers.kxta]; the command above writes that entry. Restart Codex afterwards.",
    ],
  };
}

function aiderSnippet(vars: TemplateVars, install: Install): Snippet {
  return {
    kind: "shell",
    body: `# Aider does not support MCP natively.
# Kontexta writes workflow rules to: .aider/kontexta.md
#
# To enable, add this to your .aider.conf.yml:
read:
  - .aider/kontexta.md`,
    notes: [
      "Aider integration is file-based because Aider lacks native MCP client support.",
      "Use 'admin.onboard_agent' with 'target_agent: aider' to scaffold the rules file.",
    ],
  };
}

function clineSnippet(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const hostDir = vars.hostDataDir || vars.dataDir;
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${hostDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? npmArgs(vars)
        : [vars.sourceEntrypoint];
  const env = install === "docker" || !vars.isDefaultDir ? { KONTEXTA_DATA_DIR: vars.dataDir } : undefined;
  const serverConfig: Record<string, unknown> = { command, args };
  if (env) serverConfig.env = env;
  const body = JSON.stringify({ mcpServers: { kxta: serverConfig } }, null, 2);
  return {
    kind: "json",
    body,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "Cline reads MCP config from ~/.cline/mcp_settings.json (Cline extension for VS Code / Cursor).",
      "After adding this config, reload the VS Code / Cursor window for changes to take effect.",
    ],
    configPath: "~/.cline/mcp_settings.json"
  };
}

function continueSnippet(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const hostDir = vars.hostDataDir || vars.dataDir;
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${hostDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? npmArgs(vars)
        : [vars.sourceEntrypoint];
  const showEnv = install === "docker" || !vars.isDefaultDir;
  const envBlock = showEnv ? `\n    env:\n      KONTEXTA_DATA_DIR: "${yamlDq(vars.dataDir)}"` : "";
  const body = `name: kontexta
version: ${vars.version}
schema: v1
mcpServers:
  - name: kxta
    command: "${yamlDq(command)}"
    args:
${args.map(a => `      - "${yamlDq(a)}"`).join("\n")}${envBlock}`;
  return {
    kind: "shell",
    body,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "Use this format for your ~/.continue/config.yaml or a dedicated file in ~/.continue/mcpServers/",
      "MCP tools only appear in Continue's 'Agent Mode'.",
    ],
    configPath: "~/.continue/mcpServers/kontexta.yaml"
  };
}

function copilotSnippet(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const hostDir = vars.hostDataDir || vars.dataDir;
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${hostDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? npmArgs(vars)
        : [vars.sourceEntrypoint];
  const env = install === "docker" || vars.isDefaultDir ? undefined : { KONTEXTA_DATA_DIR: vars.dataDir };
  const serverConfig: Record<string, unknown> = { type: "local", command, args };
  if (env) serverConfig.env = env;
  serverConfig.tools = ["*"];
  const body = JSON.stringify({ mcpServers: { kxta: serverConfig } }, null, 2);
  return {
    kind: "json",
    body,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "GitHub Copilot CLI reads ~/.copilot/mcp-config.json ($COPILOT_HOME/mcp-config.json when set). Or run: copilot mcp add kxta -- <command> <args>.",
      "Copilot CLI passes only PATH into MCP servers: if your data folder is somewhere non-standard (e.g. via XDG_DATA_HOME), add an env block with KONTEXTA_DATA_DIR. The Connect MCP button does this for you.",
      "Per-repository servers go in .mcp.json or .github/mcp.json and load only in trusted folders.",
    ],
  };
}

function hermesSnippet(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const hostDir = vars.hostDataDir || vars.dataDir;
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${hostDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? npmArgs(vars)
        : [vars.sourceEntrypoint];
  const showEnv = install === "docker" || !vars.isDefaultDir;
  const envBlock = showEnv ? `\n    env:\n      KONTEXTA_DATA_DIR: "${yamlDq(vars.dataDir)}"` : "";
  const body = `mcp_servers:
  kxta:
    command: "${yamlDq(command)}"
    args:
${args.map(a => `      - "${yamlDq(a)}"`).join("\n")}${envBlock}`;
  return {
    kind: "shell",
    body,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "Paste this under the existing `mcp_servers` key (create it if missing) in ~/.hermes/config.yaml, or $HERMES_HOME/config.yaml when a profile/home override is set. Never put API keys in config.yaml; those belong in .env.",
      "After editing, restart Hermes. MCP servers are loaded at startup only, there is no hot-reload.",
      "Windows: bare `npx` fails to spawn (it is a .cmd shim); point `command` at the full path, e.g. \"C:/Program Files/nodejs/npx.cmd\".",
    ],
    configPath: "~/.hermes/config.yaml (mcp_servers)"
  };
}

const TEMPLATES: Record<Client, (vars: TemplateVars, install: Install) => Snippet> = {
  "claude-code": claudeCodeShell,
  "claude-desktop": genericJson,
  cursor: genericJson,
  codex: codexShell,
  gemini: genericJson,
  antigravity: genericJson,
  "continue": continueSnippet,
  aider: aiderSnippet,
  cline: clineSnippet,
  copilot: copilotSnippet,
  hermes: hermesSnippet,
  generic: genericJson,
};

const CLIENT_CONFIG_PATHS: Record<Client, string> = {
  "claude-code": "Run this command in your terminal to configure Claude Code.",
  "claude-desktop": "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json\nWindows: %APPDATA%\\Claude\\claude_desktop_config.json",
  "cursor": "Settings → Features → MCP (or paste into your configuration file)",
  "codex": "~/.codex/config.toml ([mcp_servers.kxta]), written by `codex mcp add`",
  "gemini": "~/.gemini/settings.json",
  "antigravity": "~/.gemini/config/mcp_config.json",
  "continue": "~/.continue/mcpServers/kontexta.yaml",
  "aider": ".aider.conf.yml (global or project-local)",
  "cline": "~/.cline/mcp_settings.json (Cline extension for VS Code / Cursor)",
  "copilot": "~/.copilot/mcp-config.json (or $COPILOT_HOME/mcp-config.json), GitHub Copilot CLI",
  "hermes": "~/.hermes/config.yaml (or $HERMES_HOME/config.yaml), under the `mcp_servers` key. Restart Hermes after editing.",
  "generic": "Paste into your AI client's MCP configuration settings or file."
};

export function renderTemplate(client: Client, install: Install, vars: TemplateVars): Snippet {
  const snippet = TEMPLATES[client](vars, install);
  return {
    ...snippet,
    configPath: CLIENT_CONFIG_PATHS[client]
  };
}
