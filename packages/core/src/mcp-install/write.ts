import { copyFileSync, existsSync } from "node:fs";
import { writeJsonConfig, writeTextConfig } from "../hooks/installers/json-config.js";

// Before the first change to an existing config keep one copy next to it; later edits never overwrite that copy.
function backupOnce(path: string): void {
  const bak = `${path}.kontexta-bak`;
  if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
}

export function writeJsonWithBackup(path: string, value: unknown, dryRun = false): boolean {
  if (!writeJsonConfig(path, value, true)) return false;
  if (dryRun) return true;
  backupOnce(path);
  return writeJsonConfig(path, value, false);
}

export function writeTextWithBackup(path: string, text: string, dryRun = false): boolean {
  if (!writeTextConfig(path, text, true)) return false;
  if (dryRun) return true;
  backupOnce(path);
  return writeTextConfig(path, text, false);
}
