import { describe, it, expect } from "vitest";
import { renderEndpoints } from "../src/render/blocks/endpoints.js";

const YAML = `
- method: GET
  path: /v1/tables
  badge: direct
  description: List replicated tables
  statusCodes:
    "200": OK
    "404": Not found
- method: DELETE
  path: /v1/tables/{id}
  description: Stop replication for one table
`;

describe("renderEndpoints", () => {
  it("renders cards and collects endpoint data", () => {
    const collected: any[] = [];
    const html = renderEndpoints(YAML, collected);
    expect(html).toContain('class="api-endpoint"');
    expect(html).toContain('class="api-method"');
    expect(html).toContain("/v1/tables");
    expect(html).toContain('class="api-badge-direct"');
    expect(collected).toHaveLength(2);
    expect(collected[0].method).toBe("GET");
    expect(collected[0].id).toBe("get-v1-tables");
    expect(collected[1].id).toBe("delete-v1-tables-id");
  });

  it("throws on malformed yaml with a helpful message", () => {
    expect(() => renderEndpoints("::: not yaml :::", [])).toThrow(/endpoints/i);
  });

  it("escapes HTML in path and description", () => {
    const evil = `
- method: GET
  path: '/p"><img src=x>'
  description: 'a & b < c > d'
`;
    const html = renderEndpoints(evil, []);
    expect(html).not.toContain('"><img');
    expect(html).toContain("&quot;&gt;&lt;img");
    expect(html).toContain("a &amp; b &lt; c &gt; d");
  });

  it("falls back to GET for a non-alphabetic method", () => {
    const collected: any[] = [];
    renderEndpoints("- method: '<x>'\n  path: /a\n", collected);
    expect(collected[0].method).toBe("GET");
  });

  it("drops an unknown badge value", () => {
    const collected: any[] = [];
    const html = renderEndpoints("- method: GET\n  path: /a\n  badge: 'evil\"><svg>'\n", collected);
    expect(collected[0].badge).toBeUndefined();
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('api-badge-evil');
  });

  it("disambiguates duplicate endpoint ids", () => {
    const collected: any[] = [];
    renderEndpoints("- method: GET\n  path: /x/y\n- method: GET\n  path: /x_y\n", collected);
    expect(collected.map((e) => e.id)).toEqual(["get-x-y", "get-x-y-2"]);
  });
});
