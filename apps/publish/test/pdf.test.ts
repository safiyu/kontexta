import { describe, it, expect } from "vitest";
import { renderMarkdownToPdf } from "../src/render/pdf.js";

const MAGIC = "%PDF-";

describe("renderMarkdownToPdf", () => {
  it("produces a valid PDF for plain markdown", async () => {
    const buf = await renderMarkdownToPdf("# Hello\n\nsome body text");
    expect(buf.byteLength).toBeGreaterThan(500);
    expect(buf.toString("latin1", 0, MAGIC.length)).toBe(MAGIC);
  });

  it("embeds glyphs missing from pdfmake's bundled Roboto (arrows, checkmarks)", async () => {
    // Regression: previously rendered as blank boxes because Roboto ships
    // without these code points. DejaVu Sans covers all of them.
    const md = "Steps: click → drag ← done ✓ (fail ✗). Also ↑ ↓ ⇒.";
    const buf = await renderMarkdownToPdf(md);
    expect(buf.byteLength).toBeGreaterThan(500);
    expect(buf.toString("latin1", 0, MAGIC.length)).toBe(MAGIC);
    // Font resource name in the PDF confirms we're not silently falling
    // back to Roboto.
    expect(buf.toString("latin1")).toMatch(/DejaVuSans/);
  });

  it("routes code and pre blocks to a monospace font subset", async () => {
    // Regression: fenced code used to inherit the proportional document
    // font, so indented lines and characters in a code block didn't line
    // up. `code`/`pre` are now defaulted to DejaVuSansMono.
    const md = "Some `inline` text.\n\n```\nconst x = 1;\n```\n";
    const buf = await renderMarkdownToPdf(md);
    expect(buf.toString("latin1")).toMatch(/DejaVuSansMono/);
  });
});
