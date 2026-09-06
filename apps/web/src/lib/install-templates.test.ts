import { describe, it, expect } from "vitest";
import { renderTemplate, CLIENTS, INSTALLS } from "./install-templates";

const VARS = {
  dataDir: "/app/data",
  hostDataDir: "/home/user/kontexta-data",
  version: "1.0.0",
  sourceEntrypoint: "/abs/apps/mcp/dist/index.js",
  isDefaultDir: false,
  defaultDirDisplay: "~/.local/share/kontexta",
  hasLocalCliMcp: false,
};

const VARS_DEFAULT = { ...VARS, dataDir: "/home/user/.local/share/kontexta", isDefaultDir: true };

describe("install-templates", () => {
  it("provides every (client × install) combination", () => {
    for (const c of CLIENTS) {
      for (const i of INSTALLS) {
        const snip = renderTemplate(c, i, VARS);
        expect(snip, `missing ${c}/${i}`).toBeTruthy();
        if (c !== "aider") {
          // docker always includes KONTEXTA_DATA_DIR; npm/source include it when non-default
          if (i === "docker") {
            expect(snip.body).toContain("/app/data");
            expect(snip.body).toContain("/home/user/kontexta-data");
          } else {
            // non-default dataDir — should appear in the snippet
            expect(snip.body).toContain("/app/data");
          }
        }
      }
    }
  });

  it("omits KONTEXTA_DATA_DIR for npm/source when using OS default", () => {
    for (const c of CLIENTS) {
      if (c === "aider") continue;
      for (const i of ["npm", "source"] as const) {
        const snip = renderTemplate(c, i, VARS_DEFAULT);
        expect(snip.body).not.toContain("KONTEXTA_DATA_DIR");
      }
    }
  });
  it("Claude Code + Docker matches snapshot", () => {
    expect(renderTemplate("claude-code", "docker", VARS)).toMatchSnapshot();
  });
  it("Claude Desktop + npm matches snapshot", () => {
    expect(renderTemplate("claude-desktop", "npm", VARS)).toMatchSnapshot();
  });

  it("npm install uses kontexta-mcp by default, notes the CLI alternative", () => {
    const snip = renderTemplate("claude-desktop", "npm", VARS);
    expect(snip.body).toContain("kontexta-mcp");
    expect(snip.notes.join(" ")).toContain("npx kontexta mcp");
  });
  it("hermes renders an mcp_servers YAML block pointing at ~/.hermes/config.yaml", () => {
    const snip = renderTemplate("hermes", "npm", VARS);
    expect(snip.kind).toBe("shell");
    expect(snip.body).toContain("mcp_servers:");
    expect(snip.body).toContain("kxta:");
    expect(snip.body).toContain("kontexta-mcp");
    expect(snip.configPath).toContain("~/.hermes/config.yaml");
    expect(snip.notes.join(" ")).toContain("Windows");
    expect(snip.notes.join(" ")).toContain("restart");
  });
  it("npm install prefers a detected local kontexta CLI, notes the kontexta-mcp alternative", () => {
    const snip = renderTemplate("claude-desktop", "npm", { ...VARS, hasLocalCliMcp: true });
    expect(snip.body).toContain('"kontexta"');
    expect(snip.body).toContain('"mcp"');
    expect(snip.notes.join(" ")).toContain("npx -y kontexta-mcp");
  });
});
