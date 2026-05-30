import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import { createFile } from "../src/files/index.js";
import { addTags, registerProject } from "../src/metadata/index.js";
import { projectMap } from "../src/project-map/index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kontexta-pm-"));
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  createDatabase(join(dataDir, "test.db"));
});
afterEach(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("projectMap", () => {
  it("returns empty outline when no files exist", () => {
    const r = projectMap({ dataDir });
    expect(r.outline).toBe("");
    expect(r.stats).toEqual({ files: 0, folders: 0, roots: 0, truncated: false });
  });

  it("renders a single knowledge file with id and title", async () => {
    await createFile({ title: "Hello", content: "x".repeat(50), destination: "knowledge", dataDir });
    const r = projectMap({ dataDir });
    expect(r.outline).toContain("knowledge/");
    expect(r.outline).toMatch(/\[\d+\] Hello/);
    expect(r.stats.roots).toBe(1);
    expect(r.stats.files).toBe(1);
  });

  it("groups files by folder under their root", async () => {
    await createFile({ title: "A", content: "aaa".repeat(30), destination: "knowledge", folder: "notes", dataDir });
    await createFile({ title: "B", content: "bbb".repeat(30), destination: "knowledge", folder: "notes", dataDir });
    await createFile({ title: "C", content: "ccc".repeat(30), destination: "knowledge", folder: "drafts", dataDir });
    const r = projectMap({ dataDir });
    const lines = r.outline.split("\n");
    expect(lines[0]).toBe("knowledge/");
    expect(lines).toContain("  drafts/");
    expect(lines).toContain("  notes/");
    expect(r.stats.files).toBe(3);
    expect(r.stats.folders).toBeGreaterThanOrEqual(2);
  });

  it("inlines tags after each file with # prefix", async () => {
    const f = await createFile({
      title: "Tagged",
      content: "body content here for length",
      destination: "knowledge",
      dataDir,
      tags: ["alpha", "beta"],
    });
    void f;
    const r = projectMap({ dataDir });
    expect(r.outline).toMatch(/\[\d+\] Tagged\s+#alpha #beta/);
  });

  it("omits tags when include_tags=false", async () => {
    await createFile({ title: "T", content: "body".repeat(20), destination: "knowledge", dataDir, tags: ["x"] });
    const r = projectMap({ dataDir, include_tags: false });
    expect(r.outline).not.toContain("#x");
  });

  it("filters by project_id=null to knowledge only", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "kontexta-pm-proj-"));
    const proj = registerProject("Demo", projectDir);
    await createFile({ title: "InProject", content: "p".repeat(50), destination: "kontexta", projectId: proj.id, dataDir });
    await createFile({ title: "InKB",      content: "k".repeat(50), destination: "knowledge", dataDir });

    const r = projectMap({ dataDir, project_id: null });
    expect(r.outline).toContain("InKB");
    expect(r.outline).not.toContain("InProject");
    expect(r.stats.roots).toBe(1);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("groups project files under projects/<slug>/", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "kontexta-pm-proj-"));
    const proj = registerProject("Demo Project", projectDir);
    await createFile({ title: "ProjectFile", content: "p".repeat(50), destination: "kontexta", projectId: proj.id, dataDir });

    const r = projectMap({ dataDir });
    expect(r.outline).toMatch(new RegExp(`^projects/${proj.slug}/`, "m"));
    expect(r.outline).toContain("ProjectFile");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("addTags between calls is reflected in next outline", async () => {
    const f = await createFile({ title: "TagMe", content: "body".repeat(20), destination: "knowledge", dataDir });
    const before = projectMap({ dataDir });
    expect(before.outline).not.toContain("#fresh");
    addTags(f.id, ["fresh"]);
    const after = projectMap({ dataDir });
    expect(after.outline).toContain("#fresh");
  });

  it("respects max_lines and reports truncated:true", async () => {
    for (let i = 0; i < 20; i++) {
      await createFile({ title: `F${i}`, content: `body ${i}`.repeat(10), destination: "knowledge", dataDir });
    }
    const r = projectMap({ dataDir, max_lines: 5 });
    const lineCount = r.outline.split("\n").length;
    // 5 budgeted lines + 1 truncation marker = 6
    expect(lineCount).toBeLessThanOrEqual(6);
    expect(r.stats.truncated).toBe(true);
    expect(r.outline).toContain("truncated");
  });

  it("est_tokens scales with outline length", async () => {
    for (let i = 0; i < 10; i++) {
      await createFile({ title: `File${i}`, content: "x".repeat(100), destination: "knowledge", dataDir });
    }
    const r = projectMap({ dataDir });
    expect(r.est_tokens).toBeGreaterThan(0);
    expect(r.est_tokens).toBe(Math.ceil(r.outline.length / 4));
  });

  it("sorts folders before files at each level", async () => {
    await createFile({ title: "Zfile", content: "z".repeat(50), destination: "knowledge", dataDir });
    await createFile({ title: "AnyFile", content: "a".repeat(50), destination: "knowledge", folder: "asubfolder", dataDir });

    const r = projectMap({ dataDir });
    const lines = r.outline.split("\n");
    const folderIdx = lines.findIndex((l) => l.includes("asubfolder/"));
    const zIdx = lines.findIndex((l) => l.includes("Zfile"));
    expect(folderIdx).toBeGreaterThan(0);
    expect(zIdx).toBeGreaterThan(folderIdx);
  });
});
