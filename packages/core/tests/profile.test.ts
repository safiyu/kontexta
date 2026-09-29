import { describe, it, expect } from "vitest";
import {
  REQUIRED_SECTIONS,
  profileRelPath,
  getMissingSections,
  repairProfile,
  assembleProfile,
  parseProfileSections,
} from "../src/profile/index";

describe("profile module", () => {
  it("profileRelPath returns the correct relative path", () => {
    expect(profileRelPath()).toBe("knowledge/profile.md");
  });

  it("REQUIRED_SECTIONS contains all canonical sections", () => {
    expect(REQUIRED_SECTIONS).toEqual([
      "Name",
      "Role",
      "Vision",
      "Roadmap",
      "Preferences",
      "Session coding style",
      "Team members and roles",
      "Notes",
    ]);
  });

  describe("getMissingSections", () => {
    it("returns all sections when content is empty", () => {
      const missing = getMissingSections("");
      expect(missing).toEqual(REQUIRED_SECTIONS);
    });

    it("returns missing sections when some are present", () => {
      const content = "## Name\n\nJohn Doe\n\n## Role\n\nDeveloper\n";
      const missing = getMissingSections(content);
      expect(missing).toEqual([
        "Vision",
        "Roadmap",
        "Preferences",
        "Session coding style",
        "Team members and roles",
        "Notes",
      ]);
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
      expect(added).toEqual([
        "Role",
        "Vision",
        "Roadmap",
        "Preferences",
        "Session coding style",
        "Team members and roles",
        "Notes",
      ]);
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
        sessionCodingStyle: "one-line comments",
        teamMembersAndRoles: "Alice — PM",
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

  describe("parseProfileSections", () => {
    it("parses all 8 sections from profile markdown", () => {
      const sections = {
        name: "Ada",
        role: "Lead",
        vision: "Ship fast",
        roadmap: "Q1 launch",
        preferences: "TypeScript",
        sessionCodingStyle: "TDD",
        teamMembersAndRoles: "Bob - PM",
        notes: "Remember passwords",
      };
      const markdown = assembleProfile(sections);
      const parsed = parseProfileSections(markdown);
      expect(parsed).toEqual(sections);
    });

    it("handles missing sections by returning empty strings", () => {
      const parsed = parseProfileSections("# Profile\n\n## Name\nAda\n");
      expect(parsed.name).toBe("Ada");
      expect(parsed.role).toBe("");
      expect(parsed.notes).toBe("");
    });
  });
});

describe("repairProfile is idempotent and never duplicates", () => {
  const count = (s: string, re: RegExp) => (s.match(re) || []).length;
  const h1 = /^#\s+Profile\s*$/gm;
  const h2 = /^##\s/gm;
  const clean = assembleProfile({ name: "Ada", role: "Lead", vision: "v", roadmap: "r", preferences: "p", sessionCodingStyle: "s", teamMembersAndRoles: "t", notes: "n" });

  it("leaves an already-complete profile unchanged and does not add sections", () => {
    const { content, repaired } = repairProfile(clean);
    expect(repaired).toEqual([]);
    expect(count(content, h1)).toBe(1);
    expect(count(content, h2)).toBe(8);
    expect(content.trim()).toBe(clean.trim());
  });

  it("is a fixed point: repairing its own output changes nothing", () => {
    const once = repairProfile("# Profile\n\n## Name\nAda\n").content;
    expect(repairProfile(once).content).toBe(once);
  });

  it("keeps a preamble and custom sections exactly once", () => {
    const src = "# Profile\n\nSome intro line.\n\n## Name\nAda\n\n## Extras\nkeep me\n";
    const { content } = repairProfile(src);
    expect(count(content, /Some intro line\./g)).toBe(1);
    expect(count(content, /^## Extras$/gm)).toBe(1);
    expect(count(content, /keep me/g)).toBe(1);
    expect(count(content, h1)).toBe(1);
    expect(repairProfile(content).content).toBe(content);
  });

  it("repairs a file that was already doubled by the old bug: one H1, one of each section, no repeated bodies", () => {
    const doubled = clean + "\n" + clean + "\n" + clean;
    const { content } = repairProfile(doubled);
    expect(count(content, h1)).toBe(1);
    expect(count(content, h2)).toBe(8);
    expect(count(content, /^Ada$/gm)).toBe(1);
    expect(repairProfile(content).content).toBe(content);
  });

  it("still merges genuinely different duplicate sections instead of dropping one", () => {
    const { content } = repairProfile("# Profile\n\n## Notes\nfirst\n\n## Notes\nsecond\n");
    expect(content).toContain("first");
    expect(content).toContain("second");
    expect(count(content, /^## Notes$/gm)).toBe(1);
  });
});
