import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

let dir: string;
let prevDataDir: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.KONTEXTA_DATA_DIR;
  prevDbPath = process.env.KONTEXTA_DB_PATH;
  dir = mkdtempSync(join(tmpdir(), "kxta-web-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  process.env.KONTEXTA_DATA_DIR = dir;
  process.env.KONTEXTA_DB_PATH = join(dir, "kontexta.db");
});

afterEach(async () => {
  try {
    const { closeDatabase, resetDataDirCache } = await import("kxta-core");
    closeDatabase();
    // Reset the in-process data-dir cache so the next test (or a real run
    // after tests) doesn't inherit the temp path.
    resetDataDirCache();
  } catch {}
  // Restore env to whatever it was before the test.
  if (prevDataDir === undefined) delete process.env.KONTEXTA_DATA_DIR;
  else process.env.KONTEXTA_DATA_DIR = prevDataDir;
  if (prevDbPath === undefined) delete process.env.KONTEXTA_DB_PATH;
  else process.env.KONTEXTA_DB_PATH = prevDbPath;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});
