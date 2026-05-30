import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kxta-web-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  process.env.KONTEXTA_DATA_DIR = dir;
  process.env.KONTEXTA_DB_PATH = join(dir, "kontexta.db");
});

afterEach(async () => {
  try {
    const { closeDatabase } = await import("kxta-core");
    closeDatabase();
  } catch {}
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});
