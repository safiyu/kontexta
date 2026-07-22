// packages/core/src/journal/engine.ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const REL_BASE = ["knowledge", "journal"];

/**
 * Enumerate journal slugs that have raw events not yet reflected in their
 * high-water mark. Uses file mtimes only (no JSONL parsing) so it's cheap
 * to call every tick. Over-reporting is fine — distillJournal is idempotent
 * and returns events_processed: 0 for a slug with nothing new. Returned in
 * newest-raw-mtime-descending order so recent work distills first.
 */
export function listSlugsWithBacklog(dataDir: string): string[] {
  const journalRoot = join(dataDir, ...REL_BASE);
  if (!existsSync(journalRoot)) return [];

  const dirty: Array<{ slug: string; newestMtime: number }> = [];

  for (const entry of readdirSync(journalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const rawDir = join(journalRoot, slug, "raw");
    if (!existsSync(rawDir)) continue;

    const hwPath = join(journalRoot, slug, ".distilled-up-to.json");
    const hwMtime = existsSync(hwPath) ? statSync(hwPath).mtimeMs : null;

    let newestRawMtime = 0;
    let isDirty = hwMtime === null;
    for (const file of readdirSync(rawDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const mtime = statSync(join(rawDir, file)).mtimeMs;
      if (mtime > newestRawMtime) newestRawMtime = mtime;
      if (hwMtime !== null && mtime > hwMtime) isDirty = true;
    }
    if (newestRawMtime === 0) continue; // no raw events at all
    if (isDirty) dirty.push({ slug, newestMtime: newestRawMtime });
  }

  return dirty.sort((a, b) => b.newestMtime - a.newestMtime).map((d) => d.slug);
}
