import { describe, it, expect } from "vitest";
import manifest from "./mcp-tools.json";
import { TOOL_CATEGORIES, CATEGORY_ORDER, type ToolCategory } from "./mcp-tool-categories";

describe("mcp-tools manifest", () => {
  it("contains at least 40 tools", () => {
    expect(manifest.tools.length).toBeGreaterThanOrEqual(40);
  });
  it("each tool has name, description, inputSchema", () => {
    for (const t of manifest.tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeDefined();
    }
  });
  it("every tool name has a category mapping", () => {
    const missing: string[] = [];
    for (const t of manifest.tools) {
      if (!(t.name in TOOL_CATEGORIES)) missing.push(t.name);
    }
    expect(missing, `missing categories: ${missing.join(", ")}`).toEqual([]);
  });
  it("category map has no dead entries (renamed/removed tools)", () => {
    const liveNames = new Set(manifest.tools.map((t) => t.name));
    const dead = Object.keys(TOOL_CATEGORIES).filter((name) => !liveNames.has(name));
    expect(dead, `dead category entries: ${dead.join(", ")}`).toEqual([]);
  });
  it("CATEGORY_ORDER covers every category used in TOOL_CATEGORIES", () => {
    const used = new Set<ToolCategory>(Object.values(TOOL_CATEGORIES));
    const missing = [...used].filter((c) => !CATEGORY_ORDER.includes(c));
    expect(missing, `categories used but not in CATEGORY_ORDER: ${missing.join(", ")}`).toEqual([]);
  });
});
