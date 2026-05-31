import { describe, it, expect } from "vitest";
import { renderTemplate, CLIENTS, INSTALLS } from "./install-templates";

const VARS = {
  dataDir: "/app/data",
  hostDataDir: "/home/user/kontexta-data",
  version: "1.0.0", // Dummy version for testing templates
  sourceEntrypoint: "/abs/apps/mcp/dist/index.js",
};

describe("install-templates", () => {
  it("provides every (client × install) combination", () => {
    for (const c of CLIENTS) {
      for (const i of INSTALLS) {
        const snip = renderTemplate(c, i, VARS);
        expect(snip, `missing ${c}/${i}`).toBeTruthy();
        if (c !== "aider") {
          // dataDir is used for KONTEXTA_DATA_DIR env var in all snippets
          expect(snip.body).toContain("/app/data");
          // hostDataDir is used for volume mount strings in docker snippets
          if (i === "docker") {
            expect(snip.body).toContain("/home/user/kontexta-data");
          }
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
