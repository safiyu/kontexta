import { describe, it, expect } from "vitest";
import { createMarkdown, renderDocBody } from "../src/render/markdown.js";
import type { RenderEnv } from "../src/types.js";

describe("markdown rendering", () => {
  it("adds slugified ids to headings", () => {
    const md = createMarkdown();
    const html = md.render("## Hello World", { endpoints: [] } as RenderEnv);
    expect(html).toContain('id="hello-world"');
  });

  it("routes fenced blocks to the special transformers", () => {
    const md = createMarkdown();
    const env: RenderEnv = { endpoints: [] };
    const html = md.render(
      "```mermaid\ngraph TD;A-->B\n```\n\n```glossary\n- term: T\n  definition: D\n```",
      env,
    );
    expect(html).toContain("mermaid-wrap");
    expect(html).toContain("glossary-item");
  });

  it("collects endpoints into env and renders normal fences as code", () => {
    const md = createMarkdown();
    const env: RenderEnv = { endpoints: [] };
    const html = md.render("```endpoints\n- method: GET\n  path: /x\n```\n\n```js\nconst a=1\n```", env);
    expect(env.endpoints).toHaveLength(1);
    expect(html).toContain("api-endpoint");
    expect(html).toContain("<code"); // the js fence stays a code block
  });

  it("renderDocBody returns html + toc", () => {
    const { html, toc, endpoints } = renderDocBody("# Title\n\n## Section A\n\ntext");
    expect(html).toContain("Section A");
    expect(toc.map((t) => t.text)).toContain("Section A");
    expect(toc.find((t) => t.text === "Section A")?.id).toBe("section-a");
    expect(endpoints).toEqual([]);
  });

  it("renderDocBody collects glossary terms from a glossary fence", () => {
    const { terms } = renderDocBody("```glossary\n- term: SLT\n  definition: replication\n- term: XEED\n  definition: framed\n```");
    expect(terms).toHaveLength(2);
    expect(terms.map((t) => t.term)).toEqual(["SLT", "XEED"]);
    expect(terms[0].id).toBe("slt");
  });
});
