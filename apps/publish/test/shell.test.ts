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

  it("includes SEO meta tags when config.seo is true", () => {
    const seoCfg: PublishConfig = { ...cfg, seo: true };
    const html = assembleShell({ config: seoCfg, nav, docs, search });
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<meta property="og:title" content="Docs">');
    expect(html).toContain('<meta property="og:description"');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="twitter:title" content="Docs">');
  });

  it("omits SEO meta tags when config.seo is false", () => {
    const html = assembleShell({ config: cfg, nav, docs, search });
    expect(html).not.toContain('<meta name="description"');
    expect(html).not.toContain('<meta property="og:title"');
  });

  it("includes og:image when config.site.logo is set", () => {
    const logoCfg: PublishConfig = { ...cfg, seo: true, site: { ...cfg.site, logo: "https://example.com/logo.png" } };
    const html = assembleShell({ config: logoCfg, nav, docs, search });
    expect(html).toContain('<meta property="og:image" content="https://example.com/logo.png">');
  });

  it("applies minimal theme class to HTML element", () => {
    const minimalCfg: PublishConfig = { ...cfg, theme: "minimal" };
    const html = assembleShell({ config: minimalCfg, nav, docs, search });
    expect(html).toContain('class="dark minimal"');
  });

  it("applies api-ref theme class to HTML element", () => {
    const apiCfg: PublishConfig = { ...cfg, theme: "api-ref" };
    const html = assembleShell({ config: apiCfg, nav, docs, search });
    expect(html).toContain('class="dark api-ref"');
  });

  it("applies no theme class for default theme", () => {
    const html = assembleShell({ config: cfg, nav, docs, search });
    // default theme should have only the dark class
    expect(html).toContain('<html lang="en" class="dark">');
    expect(html).not.toContain('class="dark default"');
  });
});
