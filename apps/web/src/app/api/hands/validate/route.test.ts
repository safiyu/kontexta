import { describe, it, expect } from "vitest";
import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/hands/validate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/hands/validate", () => {
  it("returns LoadResult for a valid minimal config", async () => {
    const res = await POST(req({
      version: "1",
      tools: { "say-hi": { description: "say hi", command: ["echo", "hi"] } },
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(body.tools["say-hi"]).toBeDefined();
  });
  it("surfaces loader errors verbatim", async () => {
    const res = await POST(req({ version: "1", tools: { "Bad-Name": { description: "x", command: ["x"] } } }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.join("\n")).toMatch(/tool name 'Bad-Name' invalid/);
  });
  it("400s on non-JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/hands/validate", { method: "POST", body: "not json" }) as any);
    expect(res.status).toBe(400);
  });
});
