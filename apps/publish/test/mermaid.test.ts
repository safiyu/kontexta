import { describe, it, expect } from "vitest";
import { renderMermaid } from "../src/render/blocks/mermaid.js";

describe("renderMermaid", () => {
  it("wraps the diagram in the zoom/fullscreen container", () => {
    const html = renderMermaid("graph TD;A-->B", "api-diagram");
    expect(html).toContain('class="mermaid-wrap"');
    expect(html).toContain('id="api-diagram-wrap"');
    expect(html).toContain('class="mermaid-stage"');
    expect(html).toContain('id="api-diagram"');
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("graph TD;A--&gt;B"); // html-escaped body
    expect(html).toContain('onclick="zoomDiagram(\'api-diagram\', 0.15)"');
  });
});
