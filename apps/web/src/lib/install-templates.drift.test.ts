import { describe, it, expect } from "vitest";
import { buildServerEntry } from "kxta-core";
import { renderTemplate, type Install } from "./install-templates";

// The INSTALL tab snippet and `kontexta connect` must register the same server command.
describe("INSTALL snippets stay in sync with the MCP installer", () => {
  const vars = { dataDir: "/data/kx", hostDataDir: "/home/me/kx", version: "5.1.0", sourceEntrypoint: "/s/apps/mcp/dist/index.js", isDefaultDir: true, defaultDirDisplay: "~/kx", hasLocalCliMcp: false };
  const cases: Array<{ install: Install; local: boolean }> = [
    { install: "npm", local: false }, { install: "npm", local: true }, { install: "docker", local: false }, { install: "source", local: false },
  ];
  for (const { install, local } of cases) {
    it(`${install}${local ? " (local kontexta CLI)" : ""}: same command and args`, () => {
      const snippet = renderTemplate("cursor", install, { ...vars, hasLocalCliMcp: local });
      const fromSnippet = JSON.parse(snippet.body).mcpServers.kxta;
      const fromInstaller = buildServerEntry({
        installMode: install, version: vars.version, dataDir: vars.dataDir, hostDataDir: vars.hostDataDir,
        isDefaultDir: vars.isDefaultDir, sourceEntrypoint: vars.sourceEntrypoint, hasLocalCliMcp: local,
      });
      expect({ command: fromSnippet.command, args: fromSnippet.args }).toEqual({ command: fromInstaller.command, args: fromInstaller.args });
    });
  }
});
