import pdfMake from "pdfmake";
import htmlToPdfmake from "html-to-pdfmake";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { renderDocBody } from "./markdown.js";

const require = createRequire(import.meta.url);

// Read DejaVu Sans TTF files as raw buffers, once, at module-load time —
// in this package's own code, which is never bundled — and register them
// in pdfmake's virtual filesystem under fixed, arbitrary string keys,
// instead of using pdfmake's "standard font by name" shortcut (e.g.
// `{ Helvetica: { normal: 'Helvetica', ... } }`) or real file paths.
//
// Font choice: pdfmake ships Roboto, but Roboto's bundled TTFs omit common
// glyphs — arrows (→ ← ↑ ↓ ⇒), check marks (✓ ✗) — that appear all the
// time in tech-writing markdown; those characters silently render as blank
// boxes. DejaVu Sans covers the full BMP set we care about (arrows, math,
// checkmarks, extended Latin/Greek/Cyrillic), ships as TTFs via a stable
// npm package (`dejavu-fonts-ttf`), and is public domain.
//
// That shortcut makes pdfkit resolve font data via a path built from
// pdfkit's OWN `__dirname` at call time. This module is `require()`d from a
// Next.js API route; whenever that route ends up bundled (this happened
// under both webpack and Turbopack despite various externalization
// attempts — see the design doc for what was tried and rejected), the
// bundler relocates the code without its co-located data files, so
// `__dirname` no longer points anywhere real and pdfkit's file read throws
// ENOENT.
//
// Passing raw Buffers directly as font descriptor values was tried and
// also rejected: pdfmake's OWN `Printer.resolveUrls` (called before font
// resolution) treats any object-typed descriptor value as a
// `{url, headers}` pair — `typeof buffer === 'object'` is true for a
// Buffer, so it reads `buffer.url` (undefined) and crashes.
//
// The virtual filesystem is the mechanism pdfmake actually ships for this:
// `provideFont` checks `virtualfs.existsSync(key)` BEFORE ever touching the
// real filesystem or a `__dirname`-relative path, and a plain string key
// (not starting with a URL scheme or a slash) passes safely through
// resolveUrls's checks as a no-op ("cannot be resolved" → left alone).
const dejavuFontsDir = dirname(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"));
const DEJAVU_KEYS = {
  normal: "dejavu-sans-normal.ttf",
  bold: "dejavu-sans-bold.ttf",
  italics: "dejavu-sans-italics.ttf",
  bolditalics: "dejavu-sans-bolditalics.ttf",
};
const DEJAVU_MONO_KEYS = {
  normal: "dejavu-sans-mono-normal.ttf",
  bold: "dejavu-sans-mono-bold.ttf",
  italics: "dejavu-sans-mono-italics.ttf",
  bolditalics: "dejavu-sans-mono-bolditalics.ttf",
};
pdfMake.virtualfs.writeFileSync(DEJAVU_KEYS.normal, readFileSync(join(dejavuFontsDir, "DejaVuSans.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_KEYS.bold, readFileSync(join(dejavuFontsDir, "DejaVuSans-Bold.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_KEYS.italics, readFileSync(join(dejavuFontsDir, "DejaVuSans-Oblique.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_KEYS.bolditalics, readFileSync(join(dejavuFontsDir, "DejaVuSans-BoldOblique.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_MONO_KEYS.normal, readFileSync(join(dejavuFontsDir, "DejaVuSansMono.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_MONO_KEYS.bold, readFileSync(join(dejavuFontsDir, "DejaVuSansMono-Bold.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_MONO_KEYS.italics, readFileSync(join(dejavuFontsDir, "DejaVuSansMono-Oblique.ttf")));
pdfMake.virtualfs.writeFileSync(DEJAVU_MONO_KEYS.bolditalics, readFileSync(join(dejavuFontsDir, "DejaVuSansMono-BoldOblique.ttf")));
pdfMake.setFonts({ DejaVuSans: DEJAVU_KEYS, DejaVuSansMono: DEJAVU_MONO_KEYS });

// Note: this implementation never wires up `imagesByReference` or any
// image-fetching option, so there is no code path here that reads a
// markdown-supplied local path or fetches a markdown-supplied URL — images
// in source markdown are simply dropped by html-to-pdfmake.

/**
 * Render a markdown file's content to a PDF buffer, on the fly, with no
 * headless browser. Reuses the same markdown-it pipeline as the static-site
 * publish feature (renderDocBody), then converts the resulting HTML to a
 * pdfmake document definition and renders it with DejaVu Sans (loaded as
 * buffers — see above). Content that requires a real browser to render
 * (e.g. Mermaid diagrams) is not supported here — it appears as its raw
 * fenced-code fallback.
 */
export async function renderMarkdownToPdf(content: string): Promise<Buffer> {
  const { html } = renderDocBody(content);
  const { window } = new JSDOM("");
  // html-to-pdfmake's own defaults leave `code`/`pre` on the document font,
  // so fenced code renders in a proportional face and indented lines /
  // aligned characters no longer line up. Route those tags to the mono
  // family instead.
  const body = htmlToPdfmake(html, {
    window,
    defaultStyles: {
      code: { font: "DejaVuSansMono", fontSize: 10 },
      pre: { font: "DejaVuSansMono", fontSize: 10, margin: [0, 5, 0, 10] },
    },
  });

  const doc = pdfMake.createPdf({
    content: body,
    defaultStyle: { font: "DejaVuSans", fontSize: 11 },
    pageMargins: [40, 40, 40, 40],
  });

  return doc.getBuffer();
}
