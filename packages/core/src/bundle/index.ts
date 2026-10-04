// packages/core/src/bundle/index.ts
import { getDatabase } from "../db/index.js";
import { search } from "../metadata/index.js";
import { readFile } from "../files/index.js";
import { estimateTokensFromString } from "../util/tokens.js";
import type { SearchFilters } from "../types.js";
import { arbitrateCandidates, rerankCandidates } from "../rerank/index.js";
import { pruneLowRelevanceCandidates } from "../decision/pruning.js";
import { routeQueryIntent } from "../decision/intent-router.js";
import { evaluateSufficiency } from "../decision/sufficiency.js";
import type { RerankCandidate, ScoredCandidate } from "../rerank/types.js";
import type { FileRecordWithRank } from "../metadata/index.js";

export type BundleFormat = "xml" | "markdown";

export interface BundleOptions {
  format?: BundleFormat;
  max_tokens?: number;
  /** When true, rerank BM25 candidates with cross-encoder before packing */
  rerank?: boolean;
  /** Override candidate pool limit (default 30) */
  candidate_limit?: number;
  /** Override dictionary_boost for cross-encoder arbitration */
  dictionary_boost?: number;
  /** When true, evaluate retrieval sufficiency */
  check_sufficiency?: boolean;
  /** Minimum normalized score for a candidate to be packed (default 0.15). */
  relevance_floor?: number;
  /** When false, skip the pre-retrieval intent routing pass. */
  intent_routing?: boolean;
  /** Override the cross-encoder model identifier. */
  model?: string;
  /** Override the reranker hard timeout (ms). */
  timeout_ms?: number;
}

export interface BundleIncludedItem {
  id: number;
  path: string;
  est_tokens: number;
  /** Final reranked score, if reranking was applied */
  rerank_score?: number;
}

export interface BundleSkippedItem extends BundleIncludedItem {
  reason: "would_exceed_budget" | "below_relevance_threshold";
}

export interface BundleResult {
  bundle: string;
  meta: {
    query: string;
    format: BundleFormat;
    total_est_tokens: number;
    intent?: string;
    sufficiency?: {
      satisfied: boolean;
      confidence: number;
    };
    warning?: string;
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

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderXml(docs: DocFields[]): string {
  const inner = docs
    .map((d, i) => {
      const tagsAttr = d.tags.join(",");
      return `  <document index="${i + 1}" id="${d.id}" path="${escapeXmlAttr(d.path)}" project="${escapeXmlAttr(d.project)}" tags="${escapeXmlAttr(tagsAttr)}"><![CDATA[
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
  const skipped: BundleSkippedItem[] = [];

  let queryIntent: string | undefined;
  let dictionaryBoost = opts.dictionary_boost;

  // Step 1: Pre-retrieval Query Intent Routing (if reranking is enabled and intent routing not disabled)
  if (opts.rerank && opts.intent_routing !== false) {
    try {
      const intentResult = await routeQueryIntent(filters.query);
      queryIntent = intentResult.intent;
      if (dictionaryBoost === undefined) {
        dictionaryBoost = intentResult.dictionary_boost;
      }
    } catch {
      // Ignore intent routing failure
    }
  }

  // Step 2: Fetch candidate pool (unbiased BM25 if reranking)
  const candidateLimit = opts.candidate_limit ?? (opts.rerank ? Math.max(filters.limit ?? 30, 30) : (filters.limit ?? 1000));
  let hits: FileRecordWithRank[];
  if (opts.rerank) {
    hits = search({ ...filters, limit: candidateLimit, raw_bm25_order: true });
  } else {
    hits = search({ ...filters, limit: filters.limit ?? 1000 });
  }

  // Step 3: Neural reranking pipeline (only when enabled and hits exist)
  let rankedCandidates: Array<RerankCandidate | ScoredCandidate> = hits.map((h) => ({
    id: h.id,
    title: h.title,
    path: h.path,
    content: "",
    content_class: h.content_class ?? null,
    project_id: h.project_id ?? null,
    bm25_rank: h.rank,
  }));
  const contentMap = new Map<number, string>();

  if (opts.rerank && hits.length > 0) {
    // Read content for candidates so cross-encoder can evaluate passages
    const candidatesWithContent: RerankCandidate[] = [];
    for (const h of hits) {
      let content = "";
      try {
        const file = readFile(h.id);
        content = file.content;
        contentMap.set(h.id, file.content);
      } catch {
        // Ignored
      }
      candidatesWithContent.push({
        id: h.id,
        title: h.title,
        path: h.path,
        content,
        content_class: h.content_class ?? null,
        project_id: h.project_id ?? null,
        bm25_rank: h.rank,
      });
    }

    if (hits.length > 1) {
      // Run cross-encoder reranking
      const scored = await rerankCandidates(filters.query, candidatesWithContent, {
        model: opts.model,
        timeout_ms: opts.timeout_ms,
        candidate_limit: candidateLimit,
        dictionary_boost: dictionaryBoost,
      });

      if (scored && scored.length > 0) {
        // Apply soft content-class arbitration
        const arbitrated = arbitrateCandidates(scored, {
          dictionary_boost: dictionaryBoost,
        });

        // Prune low-relevance candidates
        const pruned = pruneLowRelevanceCandidates(arbitrated, opts.relevance_floor ?? 0.15);
        const prunedIds = new Set(pruned.map((p) => p.id));

        for (const c of arbitrated) {
          if (!prunedIds.has(c.id)) {
            const content = contentMap.get(c.id) ?? "";
            const est = estimateTokensFromString(content);
            skipped.push({
              id: c.id,
              path: c.path,
              est_tokens: est,
              rerank_score: c.final_score,
              reason: "below_relevance_threshold",
            });
          }
        }
        rankedCandidates = pruned;
      } else {
        rankedCandidates = candidatesWithContent;
      }
    } else {
      rankedCandidates = candidatesWithContent;
    }
  }

  // Step 4: Sufficiency check (if enabled and candidates available)
  let sufficiencyVerdict: { satisfied: boolean; confidence: number } | undefined;
  let sufficiencyWarning: string | undefined;

  if (opts.rerank && opts.check_sufficiency !== false && rankedCandidates.length > 0) {
    try {
      const excerpts = rankedCandidates.slice(0, 3).map((c) => {
        const text = contentMap.get(c.id) ?? c.content ?? "";
        return `${c.title}\n${text.slice(0, 500)}`;
      });
      sufficiencyVerdict = await evaluateSufficiency(filters.query, excerpts);
      if (!sufficiencyVerdict.satisfied) {
        sufficiencyWarning = "Context may be insufficient or tangential";
      }
    } catch {
      // Ignore sufficiency evaluation error
    }
  }

  // Step 5: Greedy token packing from ranked candidates
  const included: BundleIncludedItem[] = [];
  const docs: DocFields[] = [];
  let total_est_tokens = 0;

  for (const candidate of rankedCandidates) {
    let content = contentMap.get(candidate.id);
    if (content === undefined) {
      try {
        const file = readFile(candidate.id);
        content = file.content;
        contentMap.set(candidate.id, content);
      } catch {
        continue;
      }
    }

    const est = estimateTokensFromString(content);

    if (total_est_tokens + est > max_tokens) {
      skipped.push({
        id: candidate.id,
        path: candidate.path,
        est_tokens: est,
        rerank_score: "final_score" in candidate ? candidate.final_score : undefined,
        reason: "would_exceed_budget",
      });
      continue;
    }

    docs.push({
      id: candidate.id,
      path: candidate.path,
      project: getProjectName(candidate.project_id ?? null),
      tags: getTagNames(candidate.id),
      content,
    });
    included.push({
      id: candidate.id,
      path: candidate.path,
      est_tokens: est,
      rerank_score: "final_score" in candidate ? candidate.final_score : undefined,
    });
    total_est_tokens += est;
  }

  const bundle = docs.length === 0 ? "" : (format === "xml" ? renderXml(docs) : renderMarkdown(docs));

  return {
    bundle,
    meta: {
      query: filters.query,
      format,
      total_est_tokens,
      intent: queryIntent,
      sufficiency: sufficiencyVerdict,
      warning: sufficiencyWarning,
      included,
      skipped,
    },
  };
}
