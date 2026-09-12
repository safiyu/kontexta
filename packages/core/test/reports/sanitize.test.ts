import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/reports/sanitize.js";

describe("sanitizeHtml", () => {
  it("strips script tags", async () => {
    expect(await sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe("<p>hi</p>");
  });
  it("strips inline event handlers", async () => {
    expect(await sanitizeHtml('<a href="#" onclick="steal()">x</a>')).toBe('<a href="#">x</a>');
  });
  it("strips javascript: URLs", async () => {
    expect(await sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/);
  });
  it("keeps images with relative src", async () => {
    const out = await sanitizeHtml('<img src="resources/x.png" alt="x">');
    expect(out).toContain('src="resources/x.png"');
  });
  it("keeps data:image URLs", async () => {
    const out = await sanitizeHtml('<img src="data:image/png;base64,AAAA">');
    expect(out).toContain("data:image/png");
  });
  it("strips data: URLs on href", async () => {
    const out = await sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).not.toMatch(/data:text\/html/);
  });
  it("drops style tags but keeps tables — style is a covert exfil channel via url()/@import", async () => {
    const html = '<style>.a{color:red}</style><table><tr><td>x</td></tr></table>';
    expect(await sanitizeHtml(html)).toBe('<table><tbody><tr><td>x</td></tr></tbody></table>');
  });
  it("strips background: url() via the style attribute", async () => {
    const out = await sanitizeHtml('<div style="background:url(https://evil.example/beacon)">x</div>');
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/style=/);
  });
  it("strips ping attributes carrying tracking URLs", async () => {
    const out = await sanitizeHtml('<a href="/x" ping="https://evil.example/log">x</a>');
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/ping=/);
  });
});
