import { describe, it, expect } from "vitest";
import {
  REQUIRED_SECTIONS,
  profileRelPath,
  getMissingSections,
  repairProfile,
  assembleProfile,
} from "../src/profile/index";

describe("profile module", () => {
  it("profileRelPath returns the correct relative path", () => {
    expect(profileRelPath()).toBe("knowledge/profile.md");
  });

  it("REQUIRED_SECTIONS contains all six sections", () => {
    expect(REQUIRED_SECTIONS).toEqual(["Name", "Role", "Vision", "Roadmap", "Preferences", "Notes"]);
  });

  describe("getMissingSections", () => {
    it("returns all sections when content is empty", () => {
      const missing = getMissingSections("");
      expect(missing).toEqual(REQUIRED_SECTIONS);
    });

    it("returns missing sections when some are present", () => {
      const content = "## Name\n\nJohn Doe\n\n## Role\n\nDeveloper\n";
      const missing = getMissingSections(content);
      expect(missing).toEqual(["Vision", "Roadmap", "Preferences", "Notes"]);
    });

    it("returns empty array when all sections present", () => {
      const content = REQUIRED_SECTIONS.map((s) => `## ${s}\n\nContent\n`).join("\n");
      const missing = getMissingSections(content);
      expect(missing).toEqual([]);
    });
  });

  describe("repairProfile", () => {
    it("does not add sections when all are present", () => {
      const content = REQUIRED_SECTIONS.map((s) => `## ${s}\n\nContent\n`).join("\n");
      const { content: repairedContent, repaired } = repairProfile(content);
      expect(repaired).toEqual([]);
      // repairProfile always rebuilds in canonical order, so content differs but all sections present
      for (const s of REQUIRED_SECTIONS) {
        expect(repairedContent).toContain(`## ${s}`);
      }
    });

    it("inserts missing sections in canonical order", () => {
      const content = "## Name\n\nJohn Doe\n";
      const { content: repaired, repaired: added } = repairProfile(content);
      expect(added).toEqual(["Role", "Vision", "Roadmap", "Preferences", "Notes"]);
      expect(repaired).toContain("## Name");
      expect(repaired).toContain("## Role");
      expect(repaired).toContain("## Vision");
    });

    it("preserves section bodies", () => {
      const content = "## Name\n\nJohn Doe\n\n## Role\n\nSenior Developer\n";
      const { content: repaired } = repairProfile(content);
      expect(repaired).toContain("John Doe");
      expect(repaired).toContain("Senior Developer");
    });

    it("adds H1 heading if missing", () => {
      const content = "## Name\n\nJohn Doe\n";
      const { content: repaired } = repairProfile(content);
      expect(repaired).toMatch(/^# Profile/);
    });
  });

  describe("assembleProfile", () => {
    it("assembles a complete profile from sections", () => {
      const sections = {
        name: "John Doe",
        role: "Developer",
        vision: "Build great things",
        roadmap: "Step 1, Step 2",
        preferences: "TypeScript",
        notes: "Some notes",
      };
      const content = assembleProfile(sections);
      for (const section of REQUIRED_SECTIONS) {
        expect(content).toContain(`# ${section}`);
      }
      expect(content).toContain("John Doe");
      expect(content).toContain("Developer");
    });
  });
});
