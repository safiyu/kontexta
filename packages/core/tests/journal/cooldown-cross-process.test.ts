import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { acquireCooldown } from "../../src/journal/cooldown.js";
import { createDatabase, closeDatabase } from "../../src/db/index.js";

/**
 * Verify the lock is honored ACROSS separate processes, not just within a
 * single process. The file-based predecessor passed the single-process tests
 * but had a subtle TOCTOU on networked filesystems and could re-enter under
 * stale-default config. With the DB-backed implementation, SQLite's per-DB
 * write lock makes the acquire transaction atomic across processes.
 */
describe("cooldown — cross-process", () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-cooldown-xp-"));
    dbPath = join(testDir, "test.db");
    // Initialize the DB schema (migrations) so the child process can attach
    // to an already-migrated file.
    createDatabase(dbPath);
    closeDatabase();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("a second process cannot acquire while the first holds the lock", () => {
    // Process A: acquire in *this* process.
    createDatabase(dbPath);
    const tokenA = acquireCooldown(testDir, "shared", 60);
    expect(tokenA).not.toBeNull();
    closeDatabase();

    // Process B: spawn a separate node process that opens the same DB and
    // tries to acquire the same lock. It must observe the existing row and
    // return null.
    const scriptPath = join(testDir, "child.mjs");
    const projectRoot = join(__dirname, "..", "..");
    writeFileSync(scriptPath, `
import { acquireCooldown } from "${join(projectRoot, "dist", "journal", "cooldown.js").replace(/\\\\/g, "/")}";
import { createDatabase, closeDatabase } from "${join(projectRoot, "dist", "db", "index.js").replace(/\\\\/g, "/")}";
createDatabase(${JSON.stringify(dbPath)});
const t = acquireCooldown(${JSON.stringify(testDir)}, "shared", 60);
console.log(JSON.stringify({ token: t }));
closeDatabase();
`);

    const out = execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      // Don't inherit the parent's env-injected hooks
      env: { ...process.env, KONTEXTA_DATA_DIR: testDir },
    });
    const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    expect(parsed.token).toBeNull();
  });

  it("after the first process releases (or its stale window expires), the second can claim", () => {
    createDatabase(dbPath);
    // Use 0s staleness so a tiny sleep crosses the boundary without
    // requiring an actual release.
    acquireCooldown(testDir, "shared2", 0);
    closeDatabase();

    const scriptPath = join(testDir, "child2.mjs");
    const projectRoot = join(__dirname, "..", "..");
    writeFileSync(scriptPath, `
import { acquireCooldown } from "${join(projectRoot, "dist", "journal", "cooldown.js").replace(/\\\\/g, "/")}";
import { createDatabase, closeDatabase } from "${join(projectRoot, "dist", "db", "index.js").replace(/\\\\/g, "/")}";
await new Promise((r) => setTimeout(r, 20));
createDatabase(${JSON.stringify(dbPath)});
const t = acquireCooldown(${JSON.stringify(testDir)}, "shared2", 0);
console.log(JSON.stringify({ token: t }));
closeDatabase();
`);

    const out = execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, KONTEXTA_DATA_DIR: testDir },
    });
    const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    expect(parsed.token).not.toBeNull();
    expect(typeof parsed.token).toBe("string");
  });
});
