import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET, PUT } from "./route";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("profile API route", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kontexta-profile-api-test-"));
    process.env.KONTEXTA_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KONTEXTA_DATA_DIR;
  });

  it("GET returns exists:false when profile doesn't exist", async () => {
    const res = await GET(new NextRequest("http://localhost/api/profile"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exists).toBe(false);
    expect(data.content).toBeNull();
    expect(data.missing_sections).toEqual([]);
  });

  it("GET returns profile when it exists", async () => {
    const profilePath = join(tmpDir, "knowledge/profile.md");
    const knowledgeDir = join(tmpDir, "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(profilePath, "# Name\n\nJohn Doe\n");

    const res = await GET(new NextRequest("http://localhost/api/profile"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exists).toBe(true);
    expect(data.content).toContain("# Name");
    expect(data.missing_sections).toContain("Role");
  });

  it("PUT with sections form creates profile", async () => {
    const req = new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sections: {
          name: "John Doe",
          role: "Developer",
          vision: "Build great things",
          roadmap: "Step 1",
          preferences: "TypeScript",
          notes: "Some notes",
        }
      })
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.repaired).toEqual([]);

    // Verify the file was created
    const profilePath = join(tmpDir, "knowledge/profile.md");
    expect(existsSync(profilePath)).toBe(true);
    const content = readFileSync(profilePath, "utf8");
    expect(content).toContain("# Name");
    expect(content).toContain("John Doe");
  });

  it("PUT with raw content creates profile", async () => {
    const content = "# Name\n\nJohn Doe\n\n# Role\n\nDeveloper\n";
    const req = new NextRequest("http://localhost/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify the file was created
    const profilePath = join(tmpDir, "knowledge/profile.md");
    expect(existsSync(profilePath)).toBe(true);
    const fileContent = readFileSync(profilePath, "utf8");
    expect(fileContent).toContain("# Name");
    expect(fileContent).toContain("John Doe");
  });
});
