import { describe, it, expect } from "vitest";
import { renderTemplate, CLIENTS, INSTALLS } from "./install-templates";

const VARS = {
  dataDir: "/home/user/kontexta-data",
  version: "1.0.0", // Dummy version for testing templates
  sourceEntrypoint: "/abs/apps/mcp/dist/index.js",
};

describe("install-templates", () => {
  it("provides every (client × install) combination", () => {
    for (const c of CLIENTS) {
      for (const i of INSTALLS) {
        const snip = renderTemplate(c, i, VARS);
        expect(snip, `missing ${c}/${i}`).toBeTruthy();
        if (c !== "aider" && c !== "copilot") {
          expect(snip.body).toContain("/home/user/kontexta-data");
        }
      }
    }
  });
  it("Claude Code + Docker matches snapshot", () => {
    expect(renderTemplate("claude-code", "docker", VARS)).toMatchSnapshot();
  });
  it("Claude Desktop + npm matches snapshot", () => {
    expect(renderTemplate("claude-desktop", "npm", VARS)).toMatchSnapshot();
  });
});
