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
});
