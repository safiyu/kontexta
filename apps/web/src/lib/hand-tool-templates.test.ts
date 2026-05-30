import { describe, it, expect } from "vitest";
import { validateConfig } from "kontexta-mcp/hands/loader";
import { HAND_TOOL_TEMPLATES } from "./hand-tool-templates";

describe("HAND_TOOL_TEMPLATES", () => {
  it("matches snapshot", () => {
    expect(HAND_TOOL_TEMPLATES).toMatchSnapshot();
  });

  it("exports exactly eight entries", () => {
    expect(HAND_TOOL_TEMPLATES.length).toBe(8);
  });

  it("every template entry has name, oneLiner, def shape", () => {
    for (const t of HAND_TOOL_TEMPLATES) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.oneLiner).toBe("string");
      expect(t.def).toBeDefined();
      expect(Array.isArray(t.def.command)).toBe(true);
      expect(typeof t.def.description).toBe("string");
    }
  });

  it("every template's def passes validateConfig when wrapped in v1 envelope", () => {
    for (const t of HAND_TOOL_TEMPLATES) {
      const result = validateConfig(
        { version: "1", tools: { [t.name]: t.def } },
        "/unused",
      );
      expect(result.errors, `errors for ${t.name}: ${result.errors.join("; ")}`).toEqual([]);
      expect(result.tools[t.name], `${t.name} not registered: warnings=${result.warnings.join("; ")}`).toBeDefined();
    }
  });
});
