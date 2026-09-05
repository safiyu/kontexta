import { describe, it, expect } from "vitest";
import { renderHtmlToPdf, renderHtmlToPng } from "../src/render/html-export.js";

// 120s: Puppeteer's own launch()/goto() timeouts are independently set to 90s each (html-export.ts) since the one-time sandbox-discovery launch alone has been observed taking ~19s on a loaded CI runner.
describe("html-export", () => {
  it("renders HTML to a valid PDF", async () => {
    const buf = await renderHtmlToPdf("<h1>Hello</h1><p>body → arrow</p>", {});
    expect(buf.toString("latin1", 0, 5)).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(500);
  }, 120_000);

  it("renders HTML to a PNG", async () => {
    const buf = await renderHtmlToPng("<h1>Hello</h1>", {});
    expect(buf.toString("latin1", 1, 4)).toBe("PNG");
  }, 120_000);
});
