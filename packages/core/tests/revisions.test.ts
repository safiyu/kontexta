import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  compressContent,
  decompressContent,
  createRevision,
  listRevisions,
  getRevisionContent,
  computeUnifiedDiff,
  generateRevisionHash,
} from "../src/revisions/index.js";

describe("Native Revision Engine", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT
      );

      CREATE TABLE file_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        rev_hash TEXT NOT NULL,
        content_compressed BLOB NOT NULL,
        message TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'Kontexta',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
    `);
    db.prepare("INSERT INTO files (id, path, title, content) VALUES (1, 'knowledge/test.md', 'Test', 'Hello')").run();
  });

  afterEach(() => {
    db.close();
  });

  it("compresses and decompresses content roundtrip", () => {
    const original = "# Hello World\n\nThis is a sample markdown document with special chars: 🚀 and indentation.";
    const compressed = compressContent(original);
    expect(compressed.length).toBeGreaterThan(0);
    const restored = decompressContent(compressed);
    expect(restored).toBe(original);
  });

  it("creates revision and lists in reverse order", () => {
    const rev1 = createRevision(db, {
      fileId: 1,
      content: "Version 1",
      message: "Initial commit",
    });

    const rev2 = createRevision(db, {
      fileId: 1,
      content: "Version 2",
      message: "Second commit",
      author: "Test User",
    });

    const list = listRevisions(db, 1);
    expect(list.length).toBe(2);
    expect(list[0].hash).toBe(rev2.rev_hash);
    expect(list[0].message).toBe("Second commit");
    expect(list[0].author).toBe("Test User");
    expect(list[1].hash).toBe(rev1.rev_hash);
    expect(list[1].message).toBe("Initial commit");
  });

  it("retrieves content of a specific revision", () => {
    const rev = createRevision(db, {
      fileId: 1,
      content: "Unique snapshot content 123",
      message: "Snapshot",
    });

    const content = getRevisionContent(db, 1, rev.rev_hash);
    expect(content).toBe("Unique snapshot content 123");

    const nonExistent = getRevisionContent(db, 1, "nonexistenthash");
    expect(nonExistent).toBeNull();
  });

  it("generates a 40-character hex revision hash", () => {
    const hash = generateRevisionHash(1, "Test content");
    expect(hash.length).toBe(40);
    expect(/^[0-9a-f]{40}$/.test(hash)).toBe(true);
  });

  it("computes unified diff accurately", () => {
    const v1 = "Line 1\nLine 2\nLine 3";
    const v2 = "Line 1\nLine 2 Modified\nLine 3\nLine 4";

    const diff = computeUnifiedDiff(v1, v2, "test.md");
    expect(diff).toContain("--- a/test.md");
    expect(diff).toContain("+++ b/test.md");
    expect(diff).toContain("-Line 2");
    expect(diff).toContain("+Line 2 Modified");
    expect(diff).toContain("+Line 4");

    const emptyDiff = computeUnifiedDiff(v1, v1, "test.md");
    expect(emptyDiff).toBe("");
  });
});

