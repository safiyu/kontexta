import { migrateEnvVars, migrateDataFiles, getDataDir, ensureDataDir, getDatabase } from "kxta-core";

migrateEnvVars();

export const DATA_DIR = getDataDir();

export function ensureDbInitialized() {
  // Ensure the directory is created and writable
  ensureDataDir();

  migrateDataFiles(DATA_DIR);

  if (!globalThis.__kontextaDb) {
    getDatabase(); // Auto-initializes using core's unified path resolution
  }
}
