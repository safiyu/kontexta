import { getDatabase } from "../db/index.js";
import { createFile, updateFile, readFile, type FileRecordWithContent } from "../files/index.js";
import { fetchHtml, extractFromHtml, ClipError } from "./extract.js";
import { buildFrontmatter, hashBody } from "./frontmatter.js";

export { ClipError } from "./extract.js";
export type { ClipErrorCode, ClipErrorDetails, AuthSignal } from "./extract.js";

export interface ClipUrlOptions {
  url: string;
  title?: string;
  dataDir: string;
  /** Optional headers (cookies, auth) forwarded to the fetch. */
  headers?: Record<string, string>;
}

const URLCLIPS_FOLDER = "urlclips";

export async function clipUrl(opts: ClipUrlOptions): Promise<FileRecordWithContent> {
  const { url, title: titleOverride, dataDir, headers } = opts;

  const { html, finalUrl } = await fetchHtml(url, { headers });
  const { title: extractedTitle, markdown } = await extractFromHtml(html, finalUrl);
  const title = (titleOverride ?? extractedTitle).trim() || "Untitled";

  const content = buildFrontmatter({
    source: finalUrl,
    title,
    clippedAt: new Date().toISOString(),
    body: markdown,
  });

  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM files WHERE source_path = ? LIMIT 1")
    .get(finalUrl) as { id: number } | undefined;

  if (existing) {
    const current = readFile(existing.id);
    if (hashBody(current.content) === hashBody(content)) {
      return current;
    }
    return updateFile(existing.id, content, dataDir);
  }

  return createFile({
    title,
    content,
    destination: "knowledge",
    folder: URLCLIPS_FOLDER,
    sourcePath: finalUrl,
    dataDir,
  });
}
