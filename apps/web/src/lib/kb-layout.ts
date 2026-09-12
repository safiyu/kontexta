/**
 * Client-side helpers mirroring the 4.6.0 KB layout rules.
 *
 * All paths are treated as strings that may use either `/` or `\` — some
 * incoming values are POSIX (normalized by the folders API), others come
 * straight from OS-native paths on Windows. Split on both.
 */

export type KbBucket = "journal" | "knowledge" | "mermaid" | "html";
export type KbFormat = "md" | "mmd" | "html";

export const KB_BUCKETS: readonly KbBucket[] = ["journal", "knowledge", "mermaid", "html"];

const KB_BUCKET_SET = new Set<string>(KB_BUCKETS);

function segments(p: string | null | undefined): string[] {
  if (!p) return [];
  return p.split(/[/\\]/).filter(Boolean);
}

/** Top-level bucket for a KB-relative folder path, or null if not inside one. */
export function bucketOf(folder: string | null | undefined): KbBucket | null {
  const [top] = segments(folder);
  return top && KB_BUCKET_SET.has(top) ? (top as KbBucket) : null;
}

/**
 * The one file format each bucket accepts (outside html/resources, which
 * allows anything and returns null here).
 */
export function formatForBucket(bucket: KbBucket | null): KbFormat | null {
  switch (bucket) {
    case "journal":
    case "knowledge":
      return "md";
    case "mermaid":
      return "mmd";
    case "html":
      return "html";
    default:
      return null;
  }
}

/** True if the folder is `html/resources` or a descendant (any file type OK). */
export function isHtmlResources(folder: string | null | undefined): boolean {
  const parts = segments(folder);
  return parts[0] === "html" && parts[1] === "resources";
}

/** Format inferred for a folder, or null when the folder allows any (html/resources). */
export function formatForFolder(folder: string | null | undefined): KbFormat | null {
  if (isHtmlResources(folder)) return null;
  return formatForBucket(bucketOf(folder));
}

/**
 * `accept` attribute for a file input in the given folder. Null when the
 * folder isn't a KB bucket (fall back to the caller's default). Empty string
 * when the folder accepts any file (html/resources).
 */
export function acceptForFolder(folder: string | null | undefined): string | null {
  if (isHtmlResources(folder)) return "";
  const fmt = formatForFolder(folder);
  if (fmt === "md") return ".md,.markdown";
  if (fmt === "mmd") return ".mmd";
  if (fmt === "html") return ".html,.htm";
  return null;
}

/** Extension (lowercase, no leading dot) or "" for a filename. */
export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

/** True if the file extension fits the folder's format rules. */
export function fileFitsFolder(filename: string, folder: string | null | undefined): boolean {
  if (isHtmlResources(folder)) return true;
  const fmt = formatForFolder(folder);
  if (!fmt) return true;
  const ext = extOf(filename);
  if (fmt === "md") return ext === "md" || ext === "markdown";
  if (fmt === "mmd") return ext === "mmd";
  if (fmt === "html") return ext === "html" || ext === "htm";
  return true;
}
