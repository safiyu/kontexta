import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GET } from "./route";

const FLAG_NAME = ".kontexta-manual-mcp";
const HERE = dirname(fileURLToPath(import.meta.url)); // walker starts here
const REAL_MCP_ENTRYPOINT = join(process.cwd(), "..", "mcp", "dist", "index.js"); // must exist on disk for the flag to be trusted
// Flag must live in a dir whose subtree includes the entrypoint — matches real bootstrap where the flag sits at repo root and points to apps/mcp/dist/index.js inside that same tree. `apps/` contains both this test file and apps/mcp/, so place the flag there.
const LOCAL_FLAG_PATH = join(process.cwd(), "..", FLAG_NAME);

// Mirrors route.ts's own search so tests never depend on ambient flags (e.g. CI's bootstrap step writes a real one at repo root).
function findAmbientFlag(): string | null {
  let dir = HERE;
  for (let i = 0; i < 15; i++) {
    const candidate = join(dir, FLAG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let relocatedAmbientFlag: string | null = null;

beforeEach(() => {
  process.env.KONTEXTA_DATA_DIR = "/tmp/test-data";
  rmSync(LOCAL_FLAG_PATH, { force: true });
  const ambient = findAmbientFlag();
  if (ambient) {
    renameSync(ambient, ambient + ".disabled-by-test");
    relocatedAmbientFlag = ambient;
  }
});

afterEach(() => {
  rmSync(LOCAL_FLAG_PATH, { force: true });
  if (relocatedAmbientFlag) {
    renameSync(relocatedAmbientFlag + ".disabled-by-test", relocatedAmbientFlag);
    relocatedAmbientFlag = null;
  }
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
    writeFileSync(LOCAL_FLAG_PATH, REAL_MCP_ENTRYPOINT);
    vi.resetModules();
    const { GET: freshGet } = await import("./route");
    const res = await freshGet(req("client=claude-code&install=source") as any);
    const body = await res.json();
    expect(body.body).toContain(REAL_MCP_ENTRYPOINT);
  });
});
