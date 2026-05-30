import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateDataFiles, migrateProjectConfig } from "../src/compat/file-migration.js";

describe("migrateDataFiles", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-compat-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("renames mnexis.db → kontexta.db and creates .bak", () => {
    writeFileSync(join(dir, "mnexis.db"), "test-db-content");
    migrateDataFiles(dir);
    expect(existsSync(join(dir, "kontexta.db"))).toBe(true);
    expect(existsSync(join(dir, "mnexis.db.bak"))).toBe(true);
    expect(existsSync(join(dir, "mnexis.db"))).toBe(false);
    expect(readFileSync(join(dir, "kontexta.db"), "utf8")).toBe("test-db-content");
    expect(readFileSync(join(dir, "mnexis.db.bak"), "utf8")).toBe("test-db-content");
  });

  it("renames WAL and SHM files alongside the db", () => {
    writeFileSync(join(dir, "mnexis.db"), "db");
    writeFileSync(join(dir, "mnexis.db-wal"), "wal");
    writeFileSync(join(dir, "mnexis.db-shm"), "shm");
    migrateDataFiles(dir);
    expect(existsSync(join(dir, "kontexta.db-wal"))).toBe(true);
    expect(existsSync(join(dir, "kontexta.db-shm"))).toBe(true);
  });

  it("skips if kontexta.db already exists", () => {
    writeFileSync(join(dir, "mnexis.db"), "old");
    writeFileSync(join(dir, "kontexta.db"), "new");
    migrateDataFiles(dir);
    expect(readFileSync(join(dir, "kontexta.db"), "utf8")).toBe("new");
  });

  it("is a no-op when no old files exist", () => {
    migrateDataFiles(dir);
    expect(existsSync(join(dir, "kontexta.db"))).toBe(false);
  });
});

describe("migrateProjectConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-compat-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("renames mnexis.json → kontexta.json with .bak", () => {
    writeFileSync(join(dir, "mnexis.json"), '{"tools":{}}');
    migrateProjectConfig(dir);
    expect(existsSync(join(dir, "kontexta.json"))).toBe(true);
    expect(existsSync(join(dir, "mnexis.json.bak"))).toBe(true);
    expect(existsSync(join(dir, "mnexis.json"))).toBe(false);
  });

  it("skips if kontexta.json already exists", () => {
    writeFileSync(join(dir, "mnexis.json"), "old");
    writeFileSync(join(dir, "kontexta.json"), "new");
    migrateProjectConfig(dir);
    expect(readFileSync(join(dir, "kontexta.json"), "utf8")).toBe("new");
  });
});
