import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NavGroup, PublishConfig, RenderedDoc, SearchEntry, EndpointData } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read a sibling template asset (works from src in tests and dist at runtime). */
function readAsset(name: string): string {
  // assets are copied next to the compiled JS; in tests resolve from src.
  const candidates = [join(__dirname, name), join(__dirname, "../../src/template", name)];
  for (const p of candidates) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  throw new Error(`template asset not found: ${name}`);
}

/** Safe-embed JSON inside a <script> tag. */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\>");
}

export interface ShellInput {
  config: PublishConfig;
  nav: NavGroup[];
  docs: RenderedDoc[];
  search: SearchEntry[];
}

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;800&family=JetBrains+Mono:wght@400;600&family=Manrope:wght@600;700;800&display=swap";

/** Generate OpenGraph / SEO meta tags for the HTML head. */
function generateSeoMeta(config: PublishConfig, docs: RenderedDoc[]): string {
  const title = config.site.title;
  const brand = config.site.brand || title;
  // Extract a description from the first doc's HTML
  const firstDoc = docs[0];
  const description = firstDoc
    ? firstDoc.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
    : `${brand} documentation`;

  const ogImage = config.site.logo
    ? `<meta property="og:image" content="${config.site.logo}">`
    : "";

  return `<!-- SEO / OpenGraph -->
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
${ogImage}`;
}

export function assembleShell(input: ShellInput): string {
  const { config, nav, docs, search } = input;
  const theme = readAsset("theme.css");
  const app = readAsset("app.js");

  const docsMap: Record<string, { html: string; toc: RenderedDoc["toc"]; title: string; folder: string; slug: string }> = {};
  const endpoints: Record<string, EndpointData> = {};
  for (const r of docs) {
    docsMap[`${r.doc.folder}/${r.doc.slug}`] = {
      html: r.html, toc: r.toc, title: r.doc.title, folder: r.doc.folder, slug: r.doc.slug,
    };
    for (const ep of r.endpoints) endpoints[ep.id] = ep;
  }

  const hero = config.site.hero
    ? `<div class="hero"><div class="brand">${config.site.brand}</div><h1>${config.site.title}</h1></div>`
    : "";

  // SEO / OpenGraph meta tags
  const seoMeta = config.seo ? generateSeoMeta(config, docs) : "";

  // Theme class for HTML element
  const themeClass = config.theme === "minimal" ? "minimal" : config.theme === "api-ref" ? "api-ref" : "";

  return `<!doctype html>
<html lang="en" class="dark${themeClass ? " " + themeClass : ""}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${config.site.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="${FONTS}" rel="stylesheet">
<style>${theme}</style>
${seoMeta}
</head>
<body>
<div class="layout">
  <div class="topbar">
    <div class="brand">${config.site.brand || config.site.title}</div>
    <div>
      <button id="nav-toggle" aria-label="Menu">☰</button>
      <button id="search-trigger" onclick="document.getElementById('search-input').focus()">Search ⌘K</button>
      <button id="theme-toggle" aria-label="Toggle theme">◐</button>
    </div>
  </div>
  <nav class="sidebar" id="sidebar"></nav>
  <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
  <main class="content" id="content"></main>
  <aside class="toc" id="toc"></aside>
</div>

<div class="search-overlay" id="search-overlay">
  <div class="search-palette">
    <input class="search-input" id="search-input" type="text" placeholder="Search…" autocomplete="off">
    <div class="search-results" id="search-results"></div>
  </div>
</div>

<div class="modal" id="modal">
  <div class="modal-card">
    <button id="modal-close" class="modal-close" aria-label="Close">✕</button>
    <div id="modal-body"></div>
  </div>
</div>

<script>
window.__SITE__ = ${embed(config.site)};
window.__NAV__ = ${embed(nav)};
window.__DOCS__ = ${embed(docsMap)};
window.__SEARCH__ = ${embed(search)};
window.__ENDPOINTS__ = ${embed(endpoints)};
</script>
<script type="module">
import mermaid from "${MERMAID_CDN}";
mermaid.initialize({ startOnLoad: false, theme: "dark" });
window.mermaid = mermaid;
</script>
<script>${app}</script>
</body>
</html>`;
}
