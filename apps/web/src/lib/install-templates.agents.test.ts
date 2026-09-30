import { describe, it, expect } from "vitest";
import { buildServerEntry } from "kxta-core";
import { renderTemplate, type Install } from "./install-templates";

const vars = { dataDir: "/data/kx", hostDataDir: "/home/me/kx", version: "5.1.0", sourceEntrypoint: "/s/apps/mcp/dist/index.js", isDefaultDir: true, defaultDirDisplay: "~/kx", hasLocalCliMcp: false };
const entryFor = (install: Install, local = false) => buildServerEntry({ installMode: install, version: vars.version, dataDir: vars.dataDir, hostDataDir: vars.hostDataDir, isDefaultDir: true, sourceEntrypoint: vars.sourceEntrypoint, hasLocalCliMcp: local });

describe("Codex snippet uses `codex mcp add` (Codex keeps MCP servers in config.toml, not a JSON file)", () => {
  it("npm, docker and source all end with the installer's command line", () => {
    for (const install of ["npm", "docker", "source"] as Install[]) {
      const e = entryFor(install);
      const s = renderTemplate("codex", install, { ...vars });
      expect(s.kind).toBe("shell");
      expect(s.body.startsWith("codex mcp add kxta")).toBe(true);
      expect(s.body.trimEnd().endsWith(`-- ${[e.command, ...e.args].join(" ")}`)).toBe(true);
    }
  });

  it("points at config.toml, never the old JSON path", () => {
    const s = renderTemplate("codex", "npm", { ...vars });
    expect(s.configPath).toMatch(/config\.toml/);
    expect(s.configPath).not.toMatch(/mcp_servers\.json/);
  });

  it("sets the data dir with --env for a custom dir", () => {
    const s = renderTemplate("codex", "npm", { ...vars, isDefaultDir: false });
    expect(s.body).toContain("--env KONTEXTA_DATA_DIR=/data/kx");
  });
});

describe("Copilot snippet targets Copilot CLI's ~/.copilot/mcp-config.json", () => {
  it("has a local mcpServers entry matching the installer's command and args", () => {
    for (const install of ["npm", "docker", "source"] as Install[]) {
      const e = entryFor(install);
      const s = renderTemplate("copilot", install, { ...vars });
      const entry = JSON.parse(s.body).mcpServers.kxta;
      expect(entry).toMatchObject({ type: "local", command: e.command, args: e.args });
      expect(entry.tools).toEqual(["*"]);
      expect(s.configPath).toMatch(/\.copilot[\\/]mcp-config\.json/);
    }
  });
});
