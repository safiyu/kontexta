/**
 * Knowledge base layout rules (relative to <dataDir>/knowledge/):
 *   root: only profile.md as a file; folders limited to journal|knowledge|mermaid|html
 *   journal/**: .md only
 *   knowledge/**: .md only
 *   mermaid/**: .mmd only
 *   html/** (not under resources/): .html only
 *   html/resources/**: any file type (media store)
 */

const ALLOWED_ROOT_FOLDERS = new Set(["journal", "knowledge", "mermaid", "html"]);
const ROOT_ALLOWED_FILE = "profile.md";
const ALLOWED_ROOTS_LIST = "journal, knowledge, mermaid, html";

function splitSegments(relPath: string): string[] {
  return relPath.split(/[/\\]/).filter((s) => s.length > 0);
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

export function validateKnowledgeWrite(relPath: string, kind: "file" | "folder"): void {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("layout: empty path");
  }
  const parts = splitSegments(relPath);
  if (parts.length === 0) {
    throw new Error("layout: empty path");
  }
  const top = parts[0];

  if (parts.length === 1) {
    if (kind === "file") {
      if (top !== ROOT_ALLOWED_FILE) {
        throw new Error(
          `Only 'profile.md' is allowed at the knowledge root. Got: '${top}'. ` +
          `Put other files under one of: ${ALLOWED_ROOTS_LIST}.`
        );
      }
      return;
    }
    if (!ALLOWED_ROOT_FOLDERS.has(top)) {
      throw new Error(
        `Only these folders are allowed at the knowledge root: ${ALLOWED_ROOTS_LIST}. Got: '${top}'.`
      );
    }
    return;
  }

  if (!ALLOWED_ROOT_FOLDERS.has(top)) {
    throw new Error(
      `Only these folders are allowed at the knowledge root: ${ALLOWED_ROOTS_LIST}. Got: '${top}'.`
    );
  }

  if (kind === "folder") return;

  const last = parts[parts.length - 1];
  const ext = extOf(last);

  if (top === "journal" || top === "knowledge") {
    if (ext !== "md") {
      throw new Error(`${top}/ requires .md files. Got: '${relPath}'.`);
    }
    return;
  }
  if (top === "mermaid") {
    if (ext !== "mmd") {
      throw new Error(`mermaid/ requires .mmd files. Got: '${relPath}'.`);
    }
    return;
  }
  if (top === "html") {
    if (parts[1] === "resources") return;
    if (ext !== "html") {
      throw new Error(
        `html/ requires .html files (put media under html/resources/). Got: '${relPath}'.`
      );
    }
    return;
  }
}
