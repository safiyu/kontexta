import { describe, it, expect } from "vitest";
import { generateLlmsTxt } from "../src/render/llms.js";
import type { RenderedDoc, SearchEntry } from "../src/types.js";

const docs: RenderedDoc[] = [
  {
    doc: { id: 1, folder: "slt", path: "/v/slt/api.md", slug: "api", frontmatter: {}, body: "", title: "API Reference" },
    html: "<h2>Endpoints</h2><p>REST API for managing resources.</p>",
    toc: [{ level: 2, text: "Endpoints", id: "endpoints" }],
    endpoints: [{ id: "get-x", method: "GET", path: "/x" }],
    terms: [],
  },
  {
    doc: { id: 2, folder: "slt", path: "/v/slt/guide.md", slug: "guide", frontmatter: {}, body: "", title: "User Guide" },
    html: "<h1>Getting Started</h1><p>A comprehensive guide to using the platform.</p>",
    toc: [{ level: 1, text: "Getting Started", id: "getting-started" }],
    endpoints: [],
    terms: [],
  },
];
const search: SearchEntry[] = [
  { title: "GET /x", group: "slt", type: "endpoint", url: "#/slt/api", snippet: "List all resources" },
  { title: "Authentication", group: "slt", type: "term", url: "#/slt/api", snippet: "OAuth2 bearer token" },
];

describe("generateLlmsTxt", () => {
  it("produces a header with site title", () => {
    const result = generateLlmsTxt(docs, search, "My Docs");
    expect(result).toContain("# My Docs - LLM-Readable Documentation");
  });

  it("lists all docs with links and descriptions", () => {
    const result = generateLlmsTxt(docs, search, "My Docs");
    expect(result).toContain("- [API Reference](#slt/api)");
    expect(result).toContain("- [User Guide](#slt/guide)");
    // descriptions are stripped HTML
    expect(result).toContain("REST API for managing resources");
    expect(result).toContain("A comprehensive guide to using the platform");
  });

  it("includes endpoints from search entries", () => {
    const result = generateLlmsTxt(docs, search, "My Docs");
    expect(result).toContain("## Endpoints");
    expect(result).toContain("- [GET /x](#/slt/api) - List all resources");
  });

  it("includes glossary terms from search entries", () => {
    const result = generateLlmsTxt(docs, search, "My Docs");
    expect(result).toContain("## Glossary Terms");
    expect(result).toContain("- [Authentication](#/slt/api) - OAuth2 bearer token");
  });

  it("truncates long descriptions to 200 chars", () => {
    const longHtml = "<p>" + "x".repeat(300) + "</p>";
    const longDoc: RenderedDoc = {
      doc: { id: 3, folder: "slt", path: "/v/slt/long.md", slug: "long", frontmatter: {}, body: "", title: "Long Doc" },
      html: longHtml,
      toc: [],
      endpoints: [],
      terms: [],
    };
    const result = generateLlmsTxt([longDoc], [], "My Docs");
    // Should contain the truncated description (200 chars + "...")
    const match = result.match(/- \[Long Doc\].* - (.+)/);
    expect(match).toBeTruthy();
    const desc = match![1];
    expect(desc.length).toBe(203); // 200 chars + "..."
    expect(desc.endsWith("...")).toBe(true);
  });

  it("returns empty doc list gracefully", () => {
    const result = generateLlmsTxt([], [], "Empty");
    expect(result).toContain("# Empty - LLM-Readable Documentation");
    expect(result).toContain("## All Documentation");
    expect(result).toContain("## Endpoints");
    expect(result).toContain("## Glossary Terms");
    // No doc links between sections
    expect(result.split("## All Documentation")[1]?.split("## Endpoints")[0]?.trim()).toBe("");
  });
});
