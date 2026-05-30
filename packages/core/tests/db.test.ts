/**
 * Database tests
 */

import { describe, it, expect, afterEach } from "vitest";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Database", () => {
  let testDbPath: string;
  let testDir: string;

  afterEach(() => {
    closeDatabase();
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("creates all tables on init", async () => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-test-"));
    testDbPath = join(testDir, "test.db");

    const db = createDatabase(testDbPath);

    // Check that all tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("files");
    expect(tableNames).toContain("tags");
    expect(tableNames).toContain("file_tags");
    expect(tableNames).toContain("favorites");
    expect(tableNames).toContain("users");
  });

  it("creates FTS5 virtual table", async () => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-test-"));
    testDbPath = join(testDir, "test.db");

    const db = createDatabase(testDbPath);

    // Check for FTS5 virtual table
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_index'"
      )
      .all() as { name: string }[];

    expect(tables.length).toBe(1);
    expect(tables[0].name).toBe("fts_index");
  });

  it("inserts default user", async () => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-test-"));
    testDbPath = join(testDir, "test.db");

    const db = createDatabase(testDbPath);

    // Check that default user exists
    const user = db.prepare("SELECT * FROM users WHERE id = 1").get() as {
      id: number;
      name: string;
      email: string | null;
    };

    expect(user).toBeDefined();
    expect(user.id).toBe(1);
    expect(user.name).toBe("Default User");
    expect(user.email).toBeNull();
  });

  it("enables WAL mode", async () => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-test-"));
    testDbPath = join(testDir, "test.db");

    const db = createDatabase(testDbPath);

    // Check WAL mode
    const result = db.pragma("journal_mode", { simple: true }) as string;

    expect(result.toLowerCase()).toBe("wal");
  });
});
