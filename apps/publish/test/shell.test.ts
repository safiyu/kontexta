import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { assembleShell } from "../src/template/shell.js";
import type { RenderedDoc, NavGroup, SearchEntry, PublishConfig } from "../src/types.js";

const cfg: PublishConfig = {
  source: { folders: ["slt"] },
  site: { title: "Docs", brand: "Acme", hero: true },
  output: "index.html",
};
const nav: NavGroup[] = [{ group: "slt", items: [{ title: "API", slug: "api", folder: "slt" }] }];
const docs: RenderedDoc[] = [{
  doc: { id: 1, folder: "slt", path: "/v/slt/api.md", slug: "api", frontmatter: {}, body: "", title: "API" },
  html: "<h2 id=\"auth\">Auth</h2>", toc: [{ level: 2, text: "Auth", id: "auth" }],
  endpoints: [{ id: "get-x", method: "GET", path: "/x" }], terms: [],
}];
const search: SearchEntry[] = [{ title: "API", group: "slt", type: "page", url: "#/slt/api", text: "API" }];

describe("assembleShell", () => {
  it("produces a single self-contained HTML doc with embedded data + assets", () => {
    const html = assembleShell({ config: cfg, nav, docs, search });
    const dom = new JSDOM(html);
    const d = dom.window.document;
    expect(d.querySelector("title")?.textContent).toBe("Docs");
    expect(d.getElementById("sidebar")).toBeTruthy();
    expect(d.getElementById("content")).toBeTruthy();
    expect(d.getElementById("toc")).toBeTruthy();
    // embedded data
    expect(html).toContain("window.__NAV__");
    expect(html).toContain("window.__DOCS__");
    expect(html).toContain('"get-x"');           // endpoint dataset
    expect(html).toContain("Acme");               // brand
    // inlined assets
    expect(html).toContain("--accent: #B4781E");  // theme.css inlined
    expect(html).toContain("zoomDiagram");        // app.js inlined
    // mermaid CDN
    expect(html).toContain("mermaid@");
  });

  it("escapes </script> inside embedded JSON", () => {
    const evil = [...docs];
    evil[0] = { ...docs[0], html: "</script><script>alert(1)</script>" };
    const html = assembleShell({ config: cfg, nav, docs: evil, search });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });
});
