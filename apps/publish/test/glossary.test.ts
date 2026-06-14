import { describe, it, expect } from "vitest";
import { renderGlossary } from "../src/render/blocks/glossary.js";

const YAML = `
- term: SLT
  definition: SAP Landscape Transformation — real-time replication.
- term: XEED
  definition: The framed change-data format.
`;

describe("renderGlossary", () => {
  it("renders a grid of term/definition items", () => {
    const html = renderGlossary(YAML);
    expect(html).toContain('class="glossary-item"');
    expect(html).toContain('class="glossary-term"');
    expect(html).toContain('class="glossary-def"');
    expect(html).toContain("SLT");
    expect(html).toContain("real-time replication");
    expect((html.match(/glossary-item/g) ?? []).length).toBe(2);
  });

  it("throws on non-list yaml", () => {
    expect(() => renderGlossary("term: x")).toThrow(/glossary/i);
  });
});
