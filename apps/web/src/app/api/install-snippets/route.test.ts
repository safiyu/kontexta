import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GET } from "./route";

const FLAG_PATH = join(process.cwd(), ".kontexta-manual-mcp");
const REAL_MCP_ENTRYPOINT = join(process.cwd(), "..", "mcp", "dist", "index.js"); // must exist on disk for the flag to be trusted

beforeEach(() => {
  process.env.KONTEXTA_DATA_DIR = "/tmp/test-data";
  rmSync(FLAG_PATH, { force: true }); // isolate from a real dev-machine flag
});

afterEach(() => {
  rmSync(FLAG_PATH, { force: true });
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
  it("source install with no bootstrap flag returns a not-found snippet", async () => {
    vi.resetModules();
    const { GET: freshGet } = await import("./route");
    const res = await freshGet(req("client=claude-code&install=source") as any);
    const body = await res.json();
    expect(body.body).toContain("No manual/source install detected");
  });
  it("source install with a valid bootstrap flag returns the real entrypoint", async () => {
    expect(existsSync(REAL_MCP_ENTRYPOINT)).toBe(true); // pnpm -C apps/mcp build must have run
    writeFileSync(FLAG_PATH, REAL_MCP_ENTRYPOINT);
    vi.resetModules();
    const { GET: freshGet } = await import("./route");
    const res = await freshGet(req("client=claude-code&install=source") as any);
    const body = await res.json();
    expect(body.body).toContain(REAL_MCP_ENTRYPOINT);
  });
});
