import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

describe("GET /api/mcp-tools", () => {
  it("returns manifest with categories embedded", async () => {
    const req = new NextRequest("http://localhost/api/mcp-tools");
    const res = await GET(req);
    const body = await res.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools[0]).toHaveProperty("category");
    expect(body.categoryOrder).toBeDefined();
  });
});
