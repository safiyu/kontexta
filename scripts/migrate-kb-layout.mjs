#!/usr/bin/env node
/**
 * Migrate an existing Kontexta knowledge base to the 4.6.0 layout.
 *
 * The 4.6.0 rules for <dataDir>/knowledge/:
 *   root:      profile.md, plus folders journal/, knowledge/, mermaid/, html/
 *   journal/:  .md
 *   knowledge/: .md
 *   mermaid/:  .mmd
 *   html/:     .html (except html/resources/** which accepts any file)
 *
 * Everything else is off-spec. This script computes each move and prints it.
 * By default it is a DRY RUN — nothing on disk or in the DB changes.
 *
 *   node scripts/migrate-kb-layout.mjs              # dry run (default)
 *   node scripts/migrate-kb-layout.mjs --apply      # actually move
 *
 * Indexed files (rows in kontexta.db) are relocated via core's moveFile()
 * so the DB path column and FTS index stay in sync. Unindexed files (no DB
 * row) are moved with a plain fs.rename. Empty source directories are
 * removed after their contents move.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const APPLY = process.argv.includes("--apply");

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORE = path.join(REPO, "packages/core");

const require = createRequire(path.join(CORE, "package.json"));
const Database = require("better-sqlite3");

const { getDataDir, getDbPath } = await import(pathToFileURL(path.join(CORE, "dist/util/paths.js")).href);
const { moveFile } = await import(pathToFileURL(path.join(CORE, "dist/files/index.js")).href);
const { createDatabase, closeDatabase } = await import(pathToFileURL(path.join(CORE, "dist/db/index.js")).href);

const DATA_DIR = getDataDir();
const KB_ROOT = path.join(DATA_DIR, "knowledge");
const DB_PATH = getDbPath();

const ALLOWED_ROOT_FOLDERS = new Set(["journal", "knowledge", "mermaid", "html"]);
const ROOT_ALLOWED_FILE = "profile.md";

console.log(`Kontexta KB layout migration`);
console.log(`  data dir : ${DATA_DIR}`);
console.log(`  db path  : ${DB_PATH}`);
console.log(`  mode     : ${APPLY ? "APPLY (will modify disk + DB)" : "DRY RUN (no changes)"}`);
console.log(``);

if (!fs.existsSync(KB_ROOT)) {
  console.log(`No knowledge directory at ${KB_ROOT} — nothing to do.`);
  process.exit(0);
}

createDatabase(DB_PATH);
// createDatabase opens the connection managed by kxta-core; we also open our
// own read-only handle to inspect rows without racing against moveFile.
const db = new Database(DB_PATH, { readonly: true });
const indexed = new Map();
for (const row of db.prepare("SELECT id, path FROM files").all()) {
  indexed.set(path.resolve(row.path), row.id);
}
db.close();

// Media goes to html/resources/ (the one bucket accepting any extension).
const TEXT_EXTS = new Set([".md", ".markdown", ".mmd", ".html", ".htm"]);

function bucketForExt(ext) {
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".mmd") return "mermaid";
  if (ext === ".md" || ext === ".markdown") return "knowledge";
  return null; // media
}

function classifyDestination(relPath, isDir) {
  const parts = relPath.split(path.sep).filter(Boolean);
  if (parts.length === 0) return { skip: "empty" };

  const top = parts[0];
  if (isDir && parts.length === 1) {
    if (ALLOWED_ROOT_FOLDERS.has(top)) return { skip: "already allowed" };
    return { destRel: path.join("knowledge", ...parts) };
  }

  if (!isDir && parts.length === 1) {
    if (top === ROOT_ALLOWED_FILE) return { skip: "profile.md" };
    if (top.startsWith(".")) return { skip: "dotfile" };
    const ext = path.extname(top).toLowerCase();
    const bucket = bucketForExt(ext);
    if (bucket) return { destRel: path.join(bucket, top) };
    return { destRel: path.join("html", "resources", top) };
  }

  if (ALLOWED_ROOT_FOLDERS.has(top)) return { skip: "already inside allowed bucket" };

  const ext = isDir ? "" : path.extname(parts[parts.length - 1]).toLowerCase();
  if (isDir) {
    return { destRel: path.join("knowledge", ...parts) };
  }
  const bucket = bucketForExt(ext);
  if (bucket) return { destRel: path.join(bucket, ...parts) };
  return { destRel: path.join("html", "resources", ...parts) };
}

const plannedMoves = [];
const removedDirs = [];

for (const entry of fs.readdirSync(KB_ROOT, { withFileTypes: true })) {
  if (entry.name.startsWith(".")) continue;
  const entryPath = path.join(KB_ROOT, entry.name);
  if (entry.isDirectory()) {
    if (ALLOWED_ROOT_FOLDERS.has(entry.name)) continue;
    walk(entryPath, entry.name);
    removedDirs.push(entryPath);
  } else if (entry.isFile()) {
    const decision = classifyDestination(entry.name, false);
    if (decision.skip) continue;
    plannedMoves.push({ src: entryPath, destRel: decision.destRel });
  }
}

function walk(absDir, relPrefix) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    // Skip dotfiles/dotdirs — .git, .cache, .DS_Store aren't ours to rehome.
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(absDir, entry.name);
    const rel = path.join(relPrefix, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel);
      removedDirs.push(abs);
    } else if (entry.isFile()) {
      const decision = classifyDestination(rel, false);
      if (decision.skip) continue;
      plannedMoves.push({ src: abs, destRel: decision.destRel });
    }
  }
}

if (plannedMoves.length === 0) {
  console.log(`No off-spec files found. Nothing to migrate.`);
  closeDatabase();
  process.exit(0);
}

let indexedCount = 0;
let unindexedCount = 0;
for (const move of plannedMoves) {
  move.absDest = path.join(KB_ROOT, move.destRel);
  move.indexed = indexed.has(path.resolve(move.src));
  move.fileId = move.indexed ? indexed.get(path.resolve(move.src)) : null;
  if (move.indexed) indexedCount++; else unindexedCount++;
}

console.log(`Planned moves: ${plannedMoves.length} (indexed: ${indexedCount}, unindexed: ${unindexedCount})`);
console.log(``);
for (const move of plannedMoves) {
  const relSrc = path.relative(KB_ROOT, move.src);
  const tag = move.indexed ? `[indexed id=${move.fileId}]` : `[raw    ]`;
  console.log(`  ${tag}  ${relSrc}  →  ${move.destRel}`);
}

if (removedDirs.length > 0) {
  console.log(``);
  console.log(`Empty source dirs to remove after move (${removedDirs.length}):`);
  for (const d of removedDirs) {
    console.log(`  ${path.relative(KB_ROOT, d)}`);
  }
}

if (!APPLY) {
  console.log(``);
  console.log(`Dry run complete. Re-run with --apply to perform the migration.`);
  closeDatabase();
  process.exit(0);
}

console.log(``);
console.log(`Applying moves…`);

let succeeded = 0;
let failed = 0;
for (const move of plannedMoves) {
  try {
    fs.mkdirSync(path.dirname(move.absDest), { recursive: true });
    if (fs.existsSync(move.absDest)) {
      throw new Error(`destination already exists: ${move.absDest}`);
    }
    if (move.indexed) {
      moveFile(move.fileId, move.absDest, DATA_DIR);
    } else {
      // EXDEV fallback for Docker bind-mount / tmpfs data dirs.
      try {
        fs.renameSync(move.src, move.absDest);
      } catch (err) {
        if (err && err.code === "EXDEV") {
          const tmp = `${move.absDest}.${process.pid}.${Date.now()}.tmp`;
          fs.copyFileSync(move.src, tmp);
          fs.renameSync(tmp, move.absDest);
          fs.unlinkSync(move.src);
        } else {
          throw err;
        }
      }
    }
    succeeded++;
  } catch (e) {
    failed++;
    console.error(`  FAILED: ${path.relative(KB_ROOT, move.src)}: ${e?.message ?? e}`);
  }
}

for (const dir of removedDirs.sort((a, b) => b.length - a.length)) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).filter((n) => !n.startsWith(".")).length === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`  could not remove ${path.relative(KB_ROOT, dir)}: ${e?.message ?? e}`);
  }
}

console.log(``);
console.log(`Done. Moved ${succeeded} file(s). ${failed} failure(s).`);
closeDatabase();
process.exit(failed > 0 ? 1 : 0);
