import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerProject } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";
import { GET, PUT, DELETE } from "./route";
import { existsSync } from "node:fs";

let tmp: string;
let projectId: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kontexta-test-"));
  ensureDbInitialized();
  const p = registerProject("hands-cfg-test", tmp, undefined);
  projectId = p.id;
});

function req() {
  return new Request(
    `http://localhost/api/projects/${projectId}/hands-config`,
  );
}

function putReq(body: unknown) {
  return new Request(
    `http://localhost/api/projects/${projectId}/hands-config`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );
}

describe("GET /api/projects/[id]/hands-config", () => {
  it("returns exists=false when no file", async () => {
    const res = await GET(req() as any, {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const body = await res.json();
    expect(body.exists).toBe(false);
  });
  it("returns exists=true with parsed content", async () => {
    writeFileSync(
      join(tmp, "kontexta.json"),
      JSON.stringify({ version: "1", tools: {} }),
    );
    const res = await GET(req() as any, {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.parsed.version).toBe("1");
    expect(typeof body.mtimeMs).toBe("number");
  });
  it("returns parseError when file is not valid JSON", async () => {
    writeFileSync(join(tmp, "kontexta.json"), "{not json}");
    const res = await GET(req() as any, {
      params: Promise.resolve({ id: String(projectId) }),
    });
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.parseError).toBeTruthy();
    expect(body.parsed).toBeNull();
  });
});

describe("PUT /api/projects/[id]/hands-config", () => {
  it("writes and returns new mtimeMs", async () => {
    const res = await PUT(
      putReq({ config: { version: "1", tools: {} }, ifMtimeMs: null }) as any,
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.mtimeMs).toBe("number");
    const onDisk = require("node:fs").readFileSync(
      join(tmp, "kontexta.json"),
      "utf8",
    );
    expect(JSON.parse(onDisk).version).toBe("1");
  });
  it("400s on invalid config and does not write", async () => {
    const res = await PUT(
      putReq({ config: { tools: {} }, ifMtimeMs: null }) as any,
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(require("node:fs").existsSync(join(tmp, "kontexta.json"))).toBe(
      false,
    );
  });
  it("409s when ifMtimeMs is null but file already exists (creation race)", async () => {
    require("node:fs").writeFileSync(
      join(tmp, "kontexta.json"),
      JSON.stringify({ version: "1", tools: {} }),
    );
    const res = await PUT(
      putReq({ config: { version: "1", tools: {} }, ifMtimeMs: null }) as any,
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/);
    expect(typeof body.currentMtimeMs).toBe("number");
  });
  it("409s on mtime mismatch", async () => {
    require("node:fs").writeFileSync(
      join(tmp, "kontexta.json"),
      JSON.stringify({ version: "1", tools: {} }),
    );
    const stale = 1; // definitely older than the just-written file
    const res = await PUT(
      putReq({ config: { version: "1", tools: {} }, ifMtimeMs: stale }) as any,
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.currentMtimeMs).toBe("number");
  });
});

describe("DELETE /api/projects/[id]/hands-config", () => {
  it("unlinks an existing kontexta.json and returns deleted=true", async () => {
    require("node:fs").writeFileSync(
      join(tmp, "kontexta.json"),
      JSON.stringify({ version: "1", tools: {} }),
    );
    expect(existsSync(join(tmp, "kontexta.json"))).toBe(true);
    const res = await DELETE(
      new Request(`http://localhost/api/projects/${projectId}/hands-config`, { method: "DELETE" }) as any,
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(existsSync(join(tmp, "kontexta.json"))).toBe(false);
  });

  it("returns deleted=false when the file is already absent (idempotent)", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/projects/${projectId}/hands-config`, { method: "DELETE" }) as any,
      { params: Promise.resolve({ id: String(projectId) }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false });
  });

  it("404s on unknown project", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/projects/99999/hands-config`, { method: "DELETE" }) as any,
      { params: Promise.resolve({ id: "99999" }) },
    );
    expect(res.status).toBe(404);
  });
});
