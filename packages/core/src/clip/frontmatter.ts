import { computeHash } from "../files/index.js";

export interface FrontmatterFields {
  source: string;
  title: string;
  clippedAt: string;
  body: string;
}

function yamlScalar(value: string): string {
  // Quote if contains characters that break a plain YAML scalar on one line.
  // A colon followed by a space/newline or other special context breaks YAML.
  // But colons in URLs (https://) are fine.
  if (/: /.test(value) || /:\n/.test(value) || /[#\n"']/.test(value) || value.trim() !== value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function buildFrontmatter(f: FrontmatterFields): string {
  return [
    "---",
    `source: ${yamlScalar(f.source)}`,
    `title: ${yamlScalar(f.title)}`,
    `clipped_at: ${yamlScalar(f.clippedAt)}`,
    "---",
    "",
    f.body,
  ].join("\n");
}

export function splitFrontmatter(file: string): string {
  if (!file.startsWith("---\n")) return file;
  const end = file.indexOf("\n---\n", 4);
  if (end === -1) return file;
  return file.slice(end + 5).replace(/^\n+/, "");
}

export function hashBody(file: string): string {
  return computeHash(splitFrontmatter(file));
}
