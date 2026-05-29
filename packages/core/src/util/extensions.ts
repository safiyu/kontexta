/**
 * Single source of truth for which file extensions Kontexta treats as
 * first-class indexed content. Adding a new extension here makes it
 * visible to the watcher, the discover/refresh walker, file creation,
 * and the title-derivation paths in core.
 */
export const INDEXED_EXTENSIONS = [".md", ".mmd"] as const;
export type IndexedExt = (typeof INDEXED_EXTENSIONS)[number];

export function isIndexedFile(filePath: string): boolean {
  for (const ext of INDEXED_EXTENSIONS) {
    if (filePath.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Strip a recognised indexed extension off the end of a path or basename.
 * Returns the input unchanged if it does not end with an indexed extension.
 */
export function stripIndexedExt(filePath: string): string {
  for (const ext of INDEXED_EXTENSIONS) {
    if (filePath.endsWith(ext)) return filePath.slice(0, -ext.length);
  }
  return filePath;
}
