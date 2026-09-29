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
  it("keeps style tags but scrubs url() and @import — the covert exfil channels", async () => {
    const html = '<style>@import url("https://evil.example/a.css");.a{color:red;background:url(https://evil.example/b.png)}</style><table><tr><td>x</td></tr></table>';
    const out = await sanitizeHtml(html);
    expect(out).toContain("<style>");
    expect(out).toContain("color:red");
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/@import/);
    expect(out).toContain("<table><tbody><tr><td>x</td></tr></tbody></table>");
  });
  it("keeps the style attribute but neutralises background: url()", async () => {
    const out = await sanitizeHtml('<div style="color:blue;background:url(https://evil.example/beacon)">x</div>');
    expect(out).not.toMatch(/evil\.example/);
    expect(out).toContain("color:blue");
  });
  it("defeats CSS-escaped and nested url() spellings", async () => {
    const out = await sanitizeHtml('<style>.a{background:u\\72 l(https://evil.example/1)}.b{background:image-set(url(https://evil.example/2) 1x)}.c{-moz-binding:url(https://evil.example/3)}</style>');
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/url\(/i);
  });
  it("strips ping attributes carrying tracking URLs", async () => {
    const out = await sanitizeHtml('<a href="/x" ping="https://evil.example/log">x</a>');
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/ping=/);
  });
});
