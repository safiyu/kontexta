import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectFoldersWithFiles } from "../../src/files/index.js";

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), "kxta-folders-"));
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

describe("listProjectFoldersWithFiles", () => {
  it("counts .html files toward a folder's non-empty status", () => {
    mkdirSync(join(projectPath, "reports"));
    writeFileSync(join(projectPath, "reports", "q3.html"), "<p>x</p>");
    expect(listProjectFoldersWithFiles(projectPath)).toContain("reports");
  });

  it("still counts .md and .mmd files", () => {
    mkdirSync(join(projectPath, "notes"));
    writeFileSync(join(projectPath, "notes", "a.md"), "x");
    mkdirSync(join(projectPath, "diagrams"));
    writeFileSync(join(projectPath, "diagrams", "b.mmd"), "graph TD");
    const folders = listProjectFoldersWithFiles(projectPath);
    expect(folders).toContain("notes");
    expect(folders).toContain("diagrams");
  });

  it("excludes folders with only unrelated extensions", () => {
    mkdirSync(join(projectPath, "assets"));
    writeFileSync(join(projectPath, "assets", "logo.png"), "x");
    expect(listProjectFoldersWithFiles(projectPath)).not.toContain("assets");
  });
});
