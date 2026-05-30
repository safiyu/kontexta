import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "./route";

beforeEach(() => {
  process.env.KONTEXTA_DATA_DIR = "/tmp/test-data";
});

function req(qs: string) {
  return new Request(`http://localhost/api/install-snippets?${qs}`);
}

describe("GET /api/install-snippets", () => {
  it("returns a snippet for a valid combination", async () => {
    const res = await GET(req("client=claude-code&install=docker") as any);
    const body = await res.json();
    expect(body.kind).toBe("shell");
    expect(body.body).toContain("KONTEXTA_DATA_DIR");
    expect(body.body).toContain("docker run");
  });
  it("400s on bad client", async () => {
    const res = await GET(req("client=bogus&install=docker") as any);
    expect(res.status).toBe(400);
  });
  it("400s on bad install method", async () => {
    const res = await GET(req("client=claude-code&install=bogus") as any);
    expect(res.status).toBe(400);
  });
});
