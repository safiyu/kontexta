import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import type { VaultReader, VaultDoc, VaultDocMeta } from "../source/reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read a seed file from src/seeds (dev) or dist/seeds (built). */
function readSeed(name: string): string {
  const candidates = [join(__dirname, name), join(__dirname, "../seeds", name)];
  for (const p of candidates) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  throw new Error(`seed file not found: ${name}`);
}

/** Parse a seed markdown file into a VaultDoc. */
function parseSeed(name: string): VaultDoc {
  const raw = readSeed(name);
  const { data, content } = matter(raw);
  const slug = name.replace(/^\d+-/, "").replace(/\.md$/, "");
  return {
    id: parseInt(name.split("-")[0], 10),
    path: `/seeds/${name}`,
    title: (data.title as string) || slug,
    content,
  };
}

/** All seed docs, lazily loaded. */
let _cache: VaultDoc[] | null = null;
function loadSeeds(): VaultDoc[] {
  if (_cache) return _cache;
  _cache = [
    parseSeed("01-overview.md"),
    parseSeed("02-api.md"),
    parseSeed("03-improvements.md"),
    parseSeed("04-glossary.md"),
  ];
  return _cache;
}

/** A VaultReader that serves seed docs when no vault is available. */
export function createSeedReader(): VaultReader {
  const seeds = loadSeeds();
  const folder = "seeds";
  return {
    listFolders: () => [folder],
    listDocs: (f) =>
      f === folder
        ? seeds.map(({ id, path, title }) => ({ id, path, title }))
        : [],
    read: (id) => seeds.find((d) => d.id === id)!,
  };
}
