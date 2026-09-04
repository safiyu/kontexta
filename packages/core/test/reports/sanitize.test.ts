import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/reports/sanitize.js";

describe("sanitizeHtml", () => {
  it("strips script tags", () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe("<p>hi</p>");
  });
  it("strips inline event handlers", () => {
    expect(sanitizeHtml('<a href="#" onclick="steal()">x</a>')).toBe('<a href="#">x</a>');
  });
  it("strips javascript: URLs", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/);
  });
  it("keeps images with relative src", () => {
    const out = sanitizeHtml('<img src="resources/x.png" alt="x">');
    expect(out).toContain('src="resources/x.png"');
  });
  it("keeps data:image URLs", () => {
    const out = sanitizeHtml('<img src="data:image/png;base64,AAAA">');
    expect(out).toContain("data:image/png");
  });
  it("strips data: URLs on href", () => {
    const out = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).not.toMatch(/data:text\/html/);
  });
  it("keeps style tags and tables", () => {
    const html = '<style>.a{color:red}</style><table><tr><td>x</td></tr></table>';
    expect(sanitizeHtml(html)).toBe('<style>.a{color:red}</style><table><tbody><tr><td>x</td></tr></tbody></table>');
  });
});
