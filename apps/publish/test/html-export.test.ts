import { describe, it, expect, beforeAll } from "vitest";
import { renderHtmlToPdf, renderHtmlToPng, ensureChromium, warmUpChromium } from "../src/render/html-export.js";

// A cold Chromium's first-ever launch+navigate in a process can take 90s+ on
// Windows CI (antivirus/SmartScreen scanning an unfamiliar binary) — pay that
// cost here, in beforeAll's own timeout budget, so it never eats into the
// two real tests below, which should each run in a couple of seconds once
// warmed up.
beforeAll(async () => {
  const { executablePath } = await ensureChromium();
  await warmUpChromium(executablePath);
}, 180_000);

describe("html-export", () => {
  it("renders HTML to a valid PDF", async () => {
    const buf = await renderHtmlToPdf("<h1>Hello</h1><p>body → arrow</p>", {});
    expect(buf.toString("latin1", 0, 5)).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(500);
  }, 30_000);

  it("renders HTML to a PNG", async () => {
    const buf = await renderHtmlToPng("<h1>Hello</h1>", {});
    expect(buf.toString("latin1", 1, 4)).toBe("PNG");
  }, 30_000);
});
