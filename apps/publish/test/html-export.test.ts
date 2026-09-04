import { describe, it, expect } from "vitest";
import { renderHtmlToPdf, renderHtmlToPng } from "../src/render/html-export.js";

describe("html-export", () => {
  it("renders HTML to a valid PDF", async () => {
    const buf = await renderHtmlToPdf("<h1>Hello</h1><p>body → arrow</p>", {});
    expect(buf.toString("latin1", 0, 5)).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(500);
  }, 60_000);

  it("renders HTML to a PNG", async () => {
    const buf = await renderHtmlToPng("<h1>Hello</h1>", {});
    expect(buf.toString("latin1", 1, 4)).toBe("PNG");
  }, 60_000);
});
