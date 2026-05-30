import { describe, it, expect } from "vitest";
import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://localhost/api/hands/test-pattern", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/hands/test-pattern", () => {
  it("matches a valid pattern + value", async () => {
    const res = await POST(req({ pattern: "^[a-z]+$", value: "abc" }) as any);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.matches).toBe(true);
  });
  it("returns matches=false when value does not match", async () => {
    const body = await (await POST(req({ pattern: "^[a-z]+$", value: "ABC" }) as any)).json();
    expect(body.matches).toBe(false);
  });
  it("returns valid=false on uncompilable pattern", async () => {
    const body = await (await POST(req({ pattern: "([", value: "" }) as any)).json();
    expect(body.valid).toBe(false);
    expect(body.error).toBeTruthy();
  });
});
