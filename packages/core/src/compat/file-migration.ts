import { existsSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const DB_RENAMES: [string, string][] = [
  ["mnexis.db", "kontexta.db"],
  ["mnexis.db-wal", "kontexta.db-wal"],
  ["mnexis.db-shm", "kontexta.db-shm"],
];

export function migrateDataFiles(dataDir: string): void {
  for (const [oldName, newName] of DB_RENAMES) {
    const oldPath = join(dataDir, oldName);
    const newPath = join(dataDir, newName);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      copyFileSync(oldPath, oldPath + ".bak");
      renameSync(oldPath, newPath);
      console.warn(
        `[Kontexta] Migrated ${oldName} → ${newName} (backup: ${oldName}.bak). ` +
          "Automatic migration removed in v2.0.",
      );
    }
  }
}

export function migrateProjectConfig(projectRoot: string): void {
  const oldConfig = join(projectRoot, "mnexis.json");
  const newConfig = join(projectRoot, "kontexta.json");
  if (existsSync(oldConfig) && !existsSync(newConfig)) {
    copyFileSync(oldConfig, oldConfig + ".bak");
    renameSync(oldConfig, newConfig);
    console.warn(
      `[Kontexta] Migrated mnexis.json → kontexta.json in ${projectRoot} (backup: mnexis.json.bak). ` +
        "Automatic migration removed in v2.0.",
    );
  }
}
