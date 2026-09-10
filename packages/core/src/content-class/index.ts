import { relative, resolve, sep } from "node:path";
import type { ContentClass, StorageType } from "../types.js";

export interface ComputeContentClassArgs {
  storageType: StorageType;
  path: string;
  dataDir: string;
}

// Pure classifier. Rule 1 short-circuits on storage_type; rule 2 matches
// against the path relative to <dataDir>/knowledge/. Never throws — invalid
// inputs collapse to null. See docs/superpowers/specs/2026-09-10-content-class-*
export function computeContentClass(args: ComputeContentClassArgs): ContentClass | null {
  const { storageType, path, dataDir } = args;

  if (storageType !== "local") return "project";

  if (typeof path !== "string" || path.length === 0 || typeof dataDir !== "string" || dataDir.length === 0) {
    return null;
  }

  const kbRoot = resolve(dataDir, "knowledge");
  const abs = resolve(path);
  const rel = relative(kbRoot, abs);

  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;

  const norm = rel.split(sep).join("/");

  if (norm.startsWith("knowledge/dictionary/")) return "dictionary";
  if (norm.startsWith("knowledge/urlclips/")) return "dictionary";
  if (norm.startsWith("knowledge/notes/")) return "note";
  if (norm.startsWith("journal/")) return "journal";

  return null;
}
