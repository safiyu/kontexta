import pdfMake from "pdfmake";
import htmlToPdfmake from "html-to-pdfmake";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { renderDocBody } from "./markdown.js";

const require = createRequire(import.meta.url);

// Read pdfmake's own bundled Roboto TTF files as raw buffers, once, at
// module-load time — in this package's own code, which is never bundled —
// and register them in pdfmake's virtual filesystem under fixed, arbitrary
// string keys, instead of using its "standard font by name" shortcut (e.g.
// `{ Helvetica: { normal: 'Helvetica', ... } }`) or real file paths.
//
// That shortcut makes pdfkit resolve font data via a path built from
// pdfkit's OWN `__dirname` at call time. This module is `require()`d from a
// Next.js API route; whenever that route ends up bundled (this happened
// under both webpack and Turbopack despite various externalization
// attempts — see the design doc for what was tried and rejected), the
// bundler relocates the code without its co-located *.afm data files, so
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
const robotoFontsDir = dirname(require.resolve("pdfmake/fonts/Roboto/Roboto-Regular.ttf"));
const ROBOTO_KEYS = {
  normal: "roboto-normal.ttf",
  bold: "roboto-bold.ttf",
  italics: "roboto-italics.ttf",
  bolditalics: "roboto-bolditalics.ttf",
};
pdfMake.virtualfs.writeFileSync(ROBOTO_KEYS.normal, readFileSync(join(robotoFontsDir, "Roboto-Regular.ttf")));
pdfMake.virtualfs.writeFileSync(ROBOTO_KEYS.bold, readFileSync(join(robotoFontsDir, "Roboto-Medium.ttf")));
pdfMake.virtualfs.writeFileSync(ROBOTO_KEYS.italics, readFileSync(join(robotoFontsDir, "Roboto-Italic.ttf")));
pdfMake.virtualfs.writeFileSync(ROBOTO_KEYS.bolditalics, readFileSync(join(robotoFontsDir, "Roboto-MediumItalic.ttf")));
pdfMake.setFonts({ Roboto: ROBOTO_KEYS });

// Note: this implementation never wires up `imagesByReference` or any
// image-fetching option, so there is no code path here that reads a
// markdown-supplied local path or fetches a markdown-supplied URL — images
// in source markdown are simply dropped by html-to-pdfmake.

/**
 * Render a markdown file's content to a PDF buffer, on the fly, with no
 * headless browser. Reuses the same markdown-it pipeline as the static-site
 * publish feature (renderDocBody), then converts the resulting HTML to a
 * pdfmake document definition and renders it with pdfmake's bundled Roboto
 * font (loaded as buffers — see above). Content that requires a real
 * browser to render (e.g. Mermaid diagrams) is not supported here — it
 * appears as its raw fenced-code fallback.
 */
export async function renderMarkdownToPdf(content: string): Promise<Buffer> {
  const { html } = renderDocBody(content);
  const { window } = new JSDOM("");
  const body = htmlToPdfmake(html, { window });

  const doc = pdfMake.createPdf({
    content: body,
    defaultStyle: { font: "Roboto", fontSize: 11 },
    pageMargins: [40, 40, 40, 40],
  });

  return doc.getBuffer();
}
