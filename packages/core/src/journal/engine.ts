// packages/core/src/journal/engine.ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase } from "../db/index.js";

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

function deriveProjectName(slug: string): string {
  if (slug === "default") return "Default (unregistered work)";
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Return the project id for `slug`, auto-provisioning a synthetic row
 * (path: NULL) if none exists yet. Synthetic rows are how orphan journal
 * slugs (unregistered directories) become distillable without requiring
 * `register_project` first. Safe under concurrent callers, including
 * across processes — the insert is re-checked inside a transaction, and a
 * losing UNIQUE-constraint insert falls back to re-reading the winner's row.
 */
export function ensureProjectRowForSlug(slug: string): number {
  const db = getDatabase();

  const existing = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (existing) return existing.id;

  const baseName = deriveProjectName(slug);
  const description = `Auto-provisioned by distillation engine for orphan slug '${slug}'.`;

  const txn = db.transaction((): number => {
    const recheck = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: number } | undefined;
    if (recheck) return recheck.id;

    let name = baseName;
    let suffix = 0;
    for (;;) {
      const nameTaken = db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name);
      if (!nameTaken) break;
      suffix += 1;
      name = suffix === 1 ? `${baseName} (auto)` : `${baseName} (auto ${suffix})`;
    }

    try {
      const result = db
        .prepare(`INSERT INTO projects (name, slug, description, path) VALUES (?, ?, ?, NULL)`)
        .run(name, slug, description);
      return Number(result.lastInsertRowid);
    } catch (err: any) {
      if (String(err?.code) === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/.test(String(err?.message))) {
        const winner = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: number } | undefined;
        if (winner) return winner.id;
      }
      throw err;
    }
  });

  return txn();
}
