import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, readFile, updateFile } from "../../src/files/index.js";
import { createDatabase, closeDatabase } from "../../src/db/index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kxta-html-"));
  createDatabase(join(dataDir, "kontexta.db"));
});

describe("html files", () => {
  it("creates .html and preserves clean content", async () => {
    const rec = await createFile({
      title: "Report One",
      content: "<h1>Hi</h1><img src=\"resources/x.png\">",
      destination: "knowledge",
      dataDir,
      format: "html",
    });
    expect(rec.path.endsWith(".html")).toBe(true);
    expect(rec.content).toContain("<h1>Hi</h1>");
  });

  it("sanitizes on create and update", async () => {
    const rec = await createFile({
      title: "R2",
      content: '<p>ok</p><script>alert(1)</script>',
      destination: "knowledge",
      dataDir,
      format: "html",
    });
    expect(rec.content).not.toMatch(/<script/);
    const updated = await updateFile(rec.id, '<p>x</p><img src="javascript:evil">', dataDir);
    expect(updated.content).toContain("<p>x</p>");
    expect(updated.content).not.toMatch(/javascript:/);
  });
});

afterEach(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});
