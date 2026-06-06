import { describe, it, expect } from "vitest";
import { buildNav, buildSearchIndex } from "../src/render/nav.js";
import type { RenderedDoc, DocFile } from "../src/types.js";

function doc(partial: Partial<DocFile>): DocFile {
  return {
    id: 1, folder: "slt", path: "/v/slt/x.md", slug: "x",
    frontmatter: {}, body: "", title: "X", ...partial,
  };
}
function rendered(d: DocFile, extra: Partial<RenderedDoc> = {}): RenderedDoc {
  return { doc: d, html: "", toc: [], endpoints: [], ...extra };
}

describe("buildNav", () => {
  it("groups by folder and sorts by order then slug", () => {
    const docs = [
      rendered(doc({ slug: "02-api", frontmatter: { order: 2 }, title: "API" })),
      rendered(doc({ slug: "01-overview", frontmatter: { order: 1 }, title: "Overview" })),
      rendered(doc({ slug: "03-improve", title: "Improve" })), // no order → after ordered
    ];
    const nav = buildNav(docs);
    expect(nav).toHaveLength(1);
    expect(nav[0].group).toBe("slt");
    expect(nav[0].items.map((i) => i.title)).toEqual(["Overview", "API", "Improve"]);
  });

  it("uses frontmatter.group to override the folder label", () => {
    const docs = [rendered(doc({ frontmatter: { group: "SLT Direct" } }))];
    const nav = buildNav(docs);
    expect(nav[0].group).toBe("SLT Direct");
  });
});

describe("buildSearchIndex", () => {
  it("emits page, heading, endpoint and term entries", () => {
    const d = doc({ slug: "api", title: "API" });
    const docs = [
      rendered(d, {
        toc: [{ level: 2, text: "Auth", id: "auth" }],
        endpoints: [{ id: "get-x", method: "GET", path: "/x", description: "list" }],
      }),
    ];
    const idx = buildSearchIndex(docs);
    const types = idx.map((e) => e.type);
    expect(types).toContain("page");
    expect(types).toContain("heading");
    expect(types).toContain("endpoint");
    const heading = idx.find((e) => e.type === "heading");
    expect(heading?.url).toBe("#/slt/api#auth");
    const endpoint = idx.find((e) => e.type === "endpoint");
    expect(endpoint?.url).toBe("#/slt/api#get-x");
  });
});
