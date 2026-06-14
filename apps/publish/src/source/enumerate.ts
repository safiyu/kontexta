import matter from "gray-matter";
import { basename } from "node:path";
import type { VaultReader } from "./reader.js";
import type { DocFile, Frontmatter } from "../types.js";

function firstH1(md: string): string | undefined {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m?.[1];
}

/** Strip a leading numeric ordering prefix and the .md extension → slug. */
function slugFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

export function enumerateDocs(reader: VaultReader, folders: string[], projectPath?: string): DocFile[] {
  const out: DocFile[] = [];
  for (const folder of folders) {
    for (const meta of reader.listDocs(folder, projectPath)) {
      const raw = reader.read(meta.id);
      const parsed = matter(raw.content);
      const fm = parsed.data as Frontmatter;
      const body = parsed.content;
      out.push({
        id: meta.id,
        folder,
        path: raw.path,
        slug: slugFromPath(raw.path),
        frontmatter: fm,
        body,
        title: fm.title ?? firstH1(body) ?? meta.title,
      });
    }
  }
  return out;
}
