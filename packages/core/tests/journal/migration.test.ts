import { describe, it, expect, afterEach } from "vitest";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Migration 004: journaling tables", () => {
  let testDir: string;

  afterEach(() => {
    closeDatabase();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("creates journal_meta, journal_touches, journal_git_refs, journal_high_water", () => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-journal-test-"));
    const db = createDatabase(join(testDir, "test.db"));

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'journal_%'`)
      .all()
      .map((r: any) => r.name)
      .sort();

    expect(tables).toEqual([
      "journal_git_refs",
      "journal_high_water",
      "journal_locks",
      "journal_meta",
      "journal_touches",
    ]);
  });

  it("has expected indexes on journal_meta", () => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-journal-test-"));
    const db = createDatabase(join(testDir, "test.db"));

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_journal_%'`)
      .all()
      .map((r: any) => r.name)
      .sort();

    expect(indexes).toContain("idx_journal_project_active");
    expect(indexes).toContain("idx_journal_project_status");
    expect(indexes).toContain("idx_journal_task_slug");
    expect(indexes).toContain("idx_journal_touches_path");
    expect(indexes).toContain("idx_journal_git_value");
  });
});
