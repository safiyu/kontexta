// packages/core/src/journal/presence.ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export function isMcpActive(baseDir: string, projectSlug: string, windowSec: number): boolean {
  const rawDir = join(baseDir, projectSlug, "raw");
  if (!existsSync(rawDir)) return false;
  const cutoff = Date.now() - windowSec * 1000;
  for (const f of readdirSync(rawDir)) {
    if (!f.endsWith(".jsonl")) continue;
    if (statSync(join(rawDir, f)).mtimeMs >= cutoff) return true;
  }
  return false;
}
