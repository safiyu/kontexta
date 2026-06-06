import { getDataDir, ensureDataDir, getDatabase } from "kxta-core";

export const DATA_DIR = getDataDir();

export function ensureDbInitialized() {
  ensureDataDir();

  if (!globalThis.__kontextaDb) {
    getDatabase(); // Auto-initializes using core's unified path resolution
  }
}
