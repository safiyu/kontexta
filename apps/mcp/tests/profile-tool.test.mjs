import { describe, it, expect } from "vitest";
import { handleGetProfile } from "../src/profile-tool.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("handleGetProfile", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kontexta-profile-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns exists:false when profile doesn't exist", () => {
    const result = handleGetProfile(tmpDir);
    expect(result.exists).toBe(false);
    expect(result.content).toBeNull();
    expect(result.hint).toBe("Profile not yet set up — ask the user to fill it in via the web UI or by editing knowledge/profile.md");
  });

  it("returns missing_sections when profile is partial", () => {
    const profilePath = join(tmpDir, "knowledge/profile.md");
    const knowledgeDir = join(tmpDir, "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(profilePath, "# Name\n\nJohn Doe\n");

    const result = handleGetProfile(tmpDir);
    expect(result.exists).toBe(true);
    expect(result.content).toContain("# Name");
    expect(result.missing_sections).toContain("Role");
    expect(result.missing_sections).toContain("Vision");
  });

  it("returns empty missing_sections when profile is complete", () => {
    const profilePath = join(tmpDir, "knowledge/profile.md");
    const knowledgeDir = join(tmpDir, "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    const content = [
      "# Name",
      "",
      "John Doe",
      "",
      "# Role",
      "",
      "Developer",
      "",
      "# Vision",
      "",
      "Build great things",
      "",
      "# Roadmap",
      "",
      "Step 1",
      "",
      "# Preferences",
      "",
      "TypeScript",
      "",
      "# Notes",
      "",
      "Some notes",
    ].join("\n");
    writeFileSync(profilePath, content);

    const result = handleGetProfile(tmpDir);
    expect(result.exists).toBe(true);
    expect(result.content).toBe(content);
    expect(result.missing_sections).toEqual([]);
  });
});
