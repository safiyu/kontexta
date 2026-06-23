import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireCooldown, releaseCooldown } from "../../src/journal/cooldown.js";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";

describe("cooldown (DB-backed)", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-cooldown-"));
    createDatabase(join(testDir, "test.db"));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("acquires when no lock present", () => {
    const token = acquireCooldown(testDir, "p1", 60);
    expect(token).not.toBeNull();
    const row = getDatabase()
      .prepare("SELECT lock_key FROM journal_locks WHERE lock_key = ?")
      .get("distill:p1");
    expect(row).toBeDefined();
  });

  it("refuses second acquire within cooldown window", () => {
    expect(acquireCooldown(testDir, "p1", 60)).not.toBeNull();
    expect(acquireCooldown(testDir, "p1", 60)).toBeNull();
  });

  it("releases the lock", () => {
    const token = acquireCooldown(testDir, "p1", 60)!;
    releaseCooldown(testDir, "p1", token);
    expect(acquireCooldown(testDir, "p1", 60)).not.toBeNull();
  });

  it("ignores stale lock past cooldown", async () => {
    acquireCooldown(testDir, "p1", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(acquireCooldown(testDir, "p1", 0)).not.toBeNull();
  });

  it("releaseCooldown does not delete another owner's lock", () => {
    const tokenA = acquireCooldown(testDir, "p1", 0)!;
    const tokenB = acquireCooldown(testDir, "p1", 0)!;
    expect(tokenA).not.toEqual(tokenB);
    releaseCooldown(testDir, "p1", tokenA);
    const stillThere = getDatabase()
      .prepare("SELECT token FROM journal_locks WHERE lock_key = ?")
      .get("distill:p1") as { token: string } | undefined;
    expect(stillThere?.token).toBe(tokenB);
    releaseCooldown(testDir, "p1", tokenB);
    const gone = getDatabase()
      .prepare("SELECT 1 FROM journal_locks WHERE lock_key = ?")
      .get("distill:p1");
    expect(gone).toBeUndefined();
  });

  it("different project slugs don't block each other", () => {
    expect(acquireCooldown(testDir, "p1", 60)).not.toBeNull();
    expect(acquireCooldown(testDir, "p2", 60)).not.toBeNull();
  });
});
