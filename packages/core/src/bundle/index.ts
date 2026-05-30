// packages/core/src/bundle/index.ts
import { statSync } from "node:fs";
import { getDatabase } from "../db/index.js";
import { search } from "../metadata/index.js";
import { readFile } from "../files/index.js";
import { estimateTokensFromString } from "../util/tokens.js";
import type { SearchFilters } from "../types.js";

export type BundleFormat = "xml" | "markdown";

export interface BundleOptions {
  format?: BundleFormat;
  max_tokens?: number;
}

export interface BundleIncludedItem {
  id: number;
  path: string;
  est_tokens: number;
}

export interface BundleSkippedItem extends BundleIncludedItem {
  reason: "would_exceed_budget";
}

export interface BundleResult {
  bundle: string;
  meta: {
    query: string;
    format: BundleFormat;
    total_est_tokens: number;
    included: BundleIncludedItem[];
    skipped: BundleSkippedItem[];
  };
}

interface DocFields {
  id: number;
  path: string;
  project: string;
  tags: string[];
  content: string;
}

function getProjectName(projectId: number | null): string {
  if (projectId == null) return "";
  const db = getDatabase();
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  return row?.name ?? "";
}

function getTagNames(fileId: number): string[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT tags.name FROM tags
     JOIN file_tags ON file_tags.tag_id = tags.id
     WHERE file_tags.file_id = ?
     ORDER BY tags.name`
  ).all(fileId) as { name: string }[];
  return rows.map((r) => r.name);
}

// Standard CDATA escape: ]]> cannot appear inside a CDATA section.
// Split it into two sections: ]]]]><![CDATA[>
function escapeForCdata(s: string): string {
  return s.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function renderXml(docs: DocFields[]): string {
  const inner = docs
    .map((d, i) => {
      const tagsAttr = d.tags.join(",");
      return `  <document index="${i + 1}" id="${d.id}" path="${d.path}" project="${d.project}" tags="${tagsAttr}"><![CDATA[
${escapeForCdata(d.content)}
]]></document>`;
    })
    .join("\n");
  return `<documents>\n${inner}\n</documents>`;
}

function renderMarkdown(docs: DocFields[]): string {
  return docs
    .map((d) => {
      // If the content already contains a triple-backtick fence, wrap with four.
      const fence = /```/.test(d.content) ? "````" : "```";
      const metaParts: string[] = [];
      if (d.project) metaParts.push(`project: ${d.project}`);
      if (d.tags.length) metaParts.push(`tags: ${d.tags.join(", ")}`);
      const lines: string[] = [`## [${d.id}] ${d.path}`];
      if (metaParts.length) lines.push(`_${metaParts.join(" · ")}_`);
      lines.push("", `${fence}md`, d.content, fence);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

export async function bundleSearch(
  filters: SearchFilters,
  opts: BundleOptions = {}
): Promise<BundleResult> {
  const format: BundleFormat = opts.format ?? "xml";
  const max_tokens = opts.max_tokens ?? 50000;

  const hits = search(filters);

  const included: BundleIncludedItem[] = [];
  const skipped: BundleSkippedItem[] = [];
  const docs: DocFields[] = [];
  let total_est_tokens = 0;
  let stopped = false;

  for (const hit of hits) {
    if (stopped) {
      // Avoid reading the file just to estimate; use file size as a proxy
      // (~4 bytes/token, the same heuristic as estimateTokensFromString).
      let est_tokens = 0;
      try {
        est_tokens = Math.max(1, Math.ceil(statSync(hit.path).size / 4));
      } catch {}
      skipped.push({
        id: hit.id,
        path: hit.path,
        est_tokens,
        reason: "would_exceed_budget",
      });
      continue;
    }

    const file = readFile(hit.id);
    const est = estimateTokensFromString(file.content);

    if (total_est_tokens + est > max_tokens) {
      skipped.push({ id: hit.id, path: hit.path, est_tokens: est, reason: "would_exceed_budget" });
      stopped = true;
      continue;
    }

    docs.push({
      id: hit.id,
      path: hit.path,
      project: getProjectName(hit.project_id),
      tags: getTagNames(hit.id),
      content: file.content,
    });
    included.push({ id: hit.id, path: hit.path, est_tokens: est });
    total_est_tokens += est;
  }

  const bundle = docs.length === 0 ? "" : (format === "xml" ? renderXml(docs) : renderMarkdown(docs));

  return {
    bundle,
    meta: { query: filters.query, format, total_est_tokens, included, skipped },
  };
}
