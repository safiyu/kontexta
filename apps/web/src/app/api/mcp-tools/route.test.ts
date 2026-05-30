import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/mcp-tools", () => {
  it("returns manifest with categories embedded", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools[0]).toHaveProperty("category");
    expect(body.categoryOrder).toBeDefined();
  });
});
