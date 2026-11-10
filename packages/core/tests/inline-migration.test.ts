import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { readFile } from "../src/files/index.js";
import { listRevisions } from "../src/revisions/index.js";

describe("Startup Inline Content Migration", () => {
  let testDataDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDataDir = mkdtempSync(join(tmpdir(), "kontexta-inline-migration-test-"));
    dbPath = join(testDataDir, "kontexta.db");
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDataDir, { recursive: true, force: true });
  });

  it("migrates existing on-disk files into SQLite and removes them from disk", async () => {
    // 1. Create a dummy file on disk
    const filePath = join(testDataDir, "legacy-note.md");
    writeFileSync(filePath, "# Legacy Note\nMigrate me into SQLite\n", "utf8");

    // 2. Initialize database
    const db = createDatabase(dbPath);

    // 3. Insert pre-migration legacy row (storage_type='local', content=NULL)
    db.prepare(`
      INSERT INTO files (path, title, storage_type, content)
      VALUES (?, ?, 'local', NULL)
    `).run(filePath, "Legacy Note");

    // 4. Run inline migration explicitly (or on reopen)
    const { migrateInlineContent } = await import("../src/db/inline-migration.js");
    const count = migrateInlineContent(db);
    expect(count).toBe(1);

    // 5. Verify the file is now removed from disk
    expect(existsSync(filePath)).toBe(false);

    // 6. Verify row in SQLite has the content
    const row = db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as { id: number; content: string };
    expect(row.content).toBe("# Legacy Note\nMigrate me into SQLite\n");

    // 7. Verify readFile returns content
    const file = readFile(row.id);
    expect(file.content).toBe("# Legacy Note\nMigrate me into SQLite\n");

    // 8. Verify initial revision was logged
    const revisions = listRevisions(db, row.id);
    expect(revisions.length).toBe(1);
    expect(revisions[0].message).toBe("Initial inline migration");
  });
});

