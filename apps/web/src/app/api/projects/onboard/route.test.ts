import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("POST /api/projects/onboard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kontexta-onboard-test-"));
    process.env.KONTEXTA_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KONTEXTA_DATA_DIR;
  });

  it("requires agent parameter", async () => {
    const req = new NextRequest("http://localhost/api/projects/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("agent is required");
  });

  it("onboards to Knowledge Base when project_id is null/omitted", async () => {
    const req = new NextRequest("http://localhost/api/projects/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "gemini", project_id: null }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.written).toBeDefined();
    expect(data.written.length).toBeGreaterThan(0);
    expect(data.written[0].path).toBe("GEMINI.md");

    const geminiMdPath = join(tmpDir, "knowledge", "GEMINI.md");
    expect(existsSync(geminiMdPath)).toBe(true);
    const content = readFileSync(geminiMdPath, "utf8");
    expect(content).toContain("Knowledge Base");
  });
});
