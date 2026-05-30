export const CLIENTS = [
  "claude-code", "claude-desktop", "cursor", "codex", "gemini", "antigravity", "continue", "aider", "cline", "generic",
] as const;
export type Client = typeof CLIENTS[number];

export const INSTALLS = ["docker", "npm", "source"] as const;
export type Install = typeof INSTALLS[number];

export interface TemplateVars {
  dataDir: string;
  version: string;
  sourceEntrypoint: string;
}

export interface Snippet {
  kind: "shell" | "json";
  body: string;
  notes: string[];
  configPath?: string;
}

function genericJson(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${vars.dataDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? ["-y", "kontexta-mcp"]
        : [vars.sourceEntrypoint];
  const body = JSON.stringify(
    { mcpServers: { kxta: { command, args, env: { KONTEXTA_DATA_DIR: vars.dataDir } } } },
    null,
    2,
  );
  return { kind: "json", body, notes: [] };
}

function claudeCodeShell(vars: TemplateVars, install: Install): Snippet {
  const tail =
    install === "docker"
      ? `-- docker run --rm -i -v ${vars.dataDir}:/app/data safiyu/kontexta:${vars.version} mcp`
      : install === "npm"
        ? `-- npx -y kontexta-mcp`
        : `-- node ${vars.sourceEntrypoint}`;
  return {
    kind: "shell",
    body: `claude mcp add kxta -s user \\\n  -e KONTEXTA_DATA_DIR=${vars.dataDir} \\\n  ${tail}`,
    notes: [],
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
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${vars.dataDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? ["-y", "kontexta-mcp"]
        : [vars.sourceEntrypoint];
  const body = JSON.stringify(
    { mcpServers: { kxta: { command, args, env: { KONTEXTA_DATA_DIR: vars.dataDir } } } },
    null,
    2,
  );
  return { 
    kind: "json", 
    body, 
    notes: [
      "Cline reads MCP config from ~/.cline/mcp_settings.json (Cline extension for VS Code / Cursor).",
      "After adding this config, reload the VS Code / Cursor window for changes to take effect."
    ],
    configPath: "~/.cline/mcp_settings.json"
  };
}

function continueSnippet(vars: TemplateVars, install: Install): Snippet {
  const command = install === "docker" ? "docker" : install === "npm" ? "npx" : "node";
  const args =
    install === "docker"
      ? ["run", "--rm", "-i", "-v", `${vars.dataDir}:/app/data`, `safiyu/kontexta:${vars.version}`, "mcp"]
      : install === "npm"
        ? ["-y", "kontexta-mcp"]
        : [vars.sourceEntrypoint];
  const body = `name: kontexta
version: ${vars.version}
schema: v1
mcpServers:
  - name: kxta
    command: "${command}"
    args:
${args.map(a => `      - "${a}"`).join('\n')}
    env:
      KONTEXTA_DATA_DIR: "${vars.dataDir}"`;
  return { 
    kind: "shell", 
    body, 
    notes: [
      "Use this format for your ~/.continue/config.yaml or a dedicated file in ~/.continue/mcpServers/",
      "MCP tools only appear in Continue's 'Agent Mode'."
    ],
    configPath: "~/.continue/mcpServers/kontexta.yaml"
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
  "generic": "Paste into your AI client's MCP configuration settings or file."
};

export function renderTemplate(client: Client, install: Install, vars: TemplateVars): Snippet {
  const snippet = TEMPLATES[client](vars, install);
  return {
    ...snippet,
    configPath: CLIENT_CONFIG_PATHS[client]
  };
}
