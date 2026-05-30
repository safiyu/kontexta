export const CLIENTS = [
  "claude-code", "claude-desktop", "cursor", "codex", "gemini", "continue", "generic",
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
    { mcpServers: { kontexta: { command, args, env: { KONTEXTA_DATA_DIR: vars.dataDir } } } },
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
    body: `claude mcp add kontexta -s user \\\n  -e KONTEXTA_DATA_DIR=${vars.dataDir} \\\n  ${tail}`,
    notes: [],
  };
}

const TEMPLATES: Record<Client, (vars: TemplateVars, install: Install) => Snippet> = {
  "claude-code": claudeCodeShell,
  "claude-desktop": genericJson,
  cursor: genericJson,
  codex: genericJson,
  gemini: genericJson,
  continue: genericJson,
  generic: genericJson,
};

export function renderTemplate(client: Client, install: Install, vars: TemplateVars): Snippet {
  return TEMPLATES[client](vars, install);
}
