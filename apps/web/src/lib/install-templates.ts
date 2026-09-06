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
  /** True when this dashboard was launched via `npx kontexta start` — the `kontexta` package is confirmed locally installed. */
  hasLocalCliMcp: boolean;
}

export interface Snippet {
  kind: "shell" | "json";
  body: string;
  notes: string[];
  configPath?: string;
}

// A detected local `kontexta` install (from npx kontexta start) beats the generic kontexta-mcp default — same server either way.
function npmArgs(vars: TemplateVars): string[] {
  return vars.hasLocalCliMcp ? ["-y", "kontexta", "mcp"] : ["-y", "kontexta-mcp"];
}
function npmNotes(vars: TemplateVars, install: Install): string[] {
  if (install !== "npm") return [];
  return vars.hasLocalCliMcp
    ? ["Detected a local kontexta install — using its bundled MCP server. Alternative: npx -y kontexta-mcp."]
    : ["Alternative: npx kontexta mcp — same MCP server, bundled with the one-click dashboard package."];
}

function dataDirNote(vars: TemplateVars, install: Install): string {
  if (install === "docker") return `Data directory: ${vars.hostDataDir || vars.dataDir} (mounted into container)`;
  if (vars.isDefaultDir) return `Data directory: ${vars.defaultDirDisplay} (OS default — no override needed)`;
  return `Data directory: ${vars.dataDir} (custom — set via KONTEXTA_DATA_DIR)`;
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
  // using the OS default — the MCP server auto-discovers the path from the
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
  // Omit -e KONTEXTA_DATA_DIR for npm/source when using the OS default — the
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
      "Use 'onboard_agent' with 'target_agent: aider' to scaffold the rules file.",
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
  const envBlock = showEnv ? `\n    env:\n      KONTEXTA_DATA_DIR: "${vars.dataDir}"` : "";
  const body = `name: kontexta
version: ${vars.version}
schema: v1
mcpServers:
  - name: kxta
    command: "${command}"
    args:
${args.map(a => `      - "${a}"`).join('\n')}${envBlock}`;
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
  const env = install === "docker" || !vars.isDefaultDir ? { KONTEXTA_DATA_DIR: vars.dataDir } : undefined;
  const serverConfig: Record<string, unknown> = { type: "stdio", command, args };
  if (env) serverConfig.env = env;
  const body = JSON.stringify({ servers: { local: serverConfig }, inputs: [] }, null, 2);
  return {
    kind: "json",
    body,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "VS Code Insider's built-in GitHub Copilot chat supports MCP servers via mcp.json.",
      "Open your mcp.json file (e.g. ~/.config/Code\\-\\Insiders/User/mcp.json) and paste this JSON.",
      "mcp.json location — VS Code Insider: Linux: ~/.config/Code - Insiders/User/mcp.json",
      "macOS: ~/Library/Application Support/Code - Insiders/User/mcp.json",
      "Windows: %APPDATA%\\Code - Insiders\\User\\mcp.json",
    ],
    configPath: "VS Code mcp.json (servers.local)"
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
  const envBlock = showEnv ? `\n    env:\n      KONTEXTA_DATA_DIR: "${vars.dataDir}"` : "";
  const body = `mcp_servers:
  kxta:
    command: "${command}"
    args:
${args.map(a => `      - "${a}"`).join('\n')}${envBlock}`;
  return {
    kind: "shell",
    body,
    notes: [
      dataDirNote(vars, install),
      ...npmNotes(vars, install),
      "Paste this under the existing `mcp_servers` key (create it if missing) in ~/.hermes/config.yaml — or $HERMES_HOME/config.yaml when a profile/home override is set. Never put API keys in config.yaml; those belong in .env.",
      "After editing, restart Hermes — MCP servers are loaded at startup only, there is no hot-reload.",
      "Windows: bare `npx` fails to spawn (it is a .cmd shim); point `command` at the full path, e.g. \"C:/Program Files/nodejs/npx.cmd\".",
    ],
    configPath: "~/.hermes/config.yaml (mcp_servers)"
  };
}

const TEMPLATES: Record<Client, (vars: TemplateVars, install: Install) => Snippet> = {
  "claude-code": claudeCodeShell,
  "claude-desktop": genericJson,
  cursor: genericJson,
  codex: genericJson,
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
  "codex": ".codex/mcp_servers.json",
  "gemini": "~/.gemini/antigravity/mcp_servers.json",
  "antigravity": "~/.gemini/antigravity/mcp_servers.json",
  "continue": "~/.continue/mcpServers/kontexta.yaml",
  "aider": ".aider.conf.yml (global or project-local)",
  "cline": "~/.cline/mcp_settings.json (Cline extension for VS Code / Cursor)",
  "copilot": "VS Code Settings → mcp.servers (VS Code Insider built-in Copilot chat)",
  "hermes": "~/.hermes/config.yaml (or $HERMES_HOME/config.yaml) — under the `mcp_servers` key. Restart Hermes after editing.",
  "generic": "Paste into your AI client's MCP configuration settings or file."
};

export function renderTemplate(client: Client, install: Install, vars: TemplateVars): Snippet {
  const snippet = TEMPLATES[client](vars, install);
  return {
    ...snippet,
    configPath: CLIENT_CONFIG_PATHS[client]
  };
}
