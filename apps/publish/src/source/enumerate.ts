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
      // Skip unreadable docs (e.g. DB row points at a path that was deleted
      // out from under the watcher). Without this, a single orphan row
      // would tank the entire publish run with an ENOENT — the user clicks
      // "Publish" and gets a 500 with no actionable signal. Log the path
      // so it shows up in the server logs for cleanup.
      let raw;
      try {
        raw = reader.read(meta.id);
      } catch (err) {
        console.warn(
          `[publish] skipping unreadable doc id=${meta.id} path=${meta.path}: ${(err as Error).message}`,
        );
        continue;
      }
      let parsed;
      try {
        parsed = matter(raw.content);
      } catch (err) {
        console.warn(
          `[publish] skipping doc with bad frontmatter id=${meta.id} path=${meta.path}: ${(err as Error).message}`,
        );
        continue;
      }
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
