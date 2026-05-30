import { createDatabase } from "kxta-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const DATA_DIR = process.env.KONTEXTA_DATA_DIR || path.join(REPO_ROOT, "data");
const DB_PATH = process.env.KONTEXTA_DB_PATH || path.join(DATA_DIR, "kontexta.db");

function safeMkdir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") {
      throw new Error(
        `Kontexta cannot write to data directory: ${dir} (${e.code}). ` +
          `Set KONTEXTA_DATA_DIR to a writable path, or fix permissions on ${dir}.`
      );
    }
    throw e;
  }
}

export function ensureDbInitialized() {
  // Ensure DATA_DIR exists
  if (!fs.existsSync(DATA_DIR)) {
    safeMkdir(DATA_DIR);
  }
  // Even if it exists, make sure we can actually write (mounted-ro volumes).
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch {
    throw new Error(
      `Kontexta data directory ${DATA_DIR} is not writable. ` +
        `Set KONTEXTA_DATA_DIR to a writable path, or fix permissions.`
    );
  }

  // Ensure standard subdirectories exist
  const dirs = ["knowledge", "backups", "projects"];
  for (const d of dirs) {
    const fullPath = path.join(DATA_DIR, d);
    if (!fs.existsSync(fullPath)) {
      safeMkdir(fullPath);
    }
  }

  // Always check if DB exists on globalThis, don't rely on local flag
  if (!globalThis.__kontextaDb) {
    const dbPath = process.env.KONTEXTA_DB_PATH || DB_PATH;
    createDatabase(dbPath);
  }
}

export { DATA_DIR, DB_PATH };
