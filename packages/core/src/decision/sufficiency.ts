// packages/core/src/decision/sufficiency.ts
/**
 * Relevance sufficiency evaluation.
 *
 * Determines whether the retrieved candidate excerpts provide
 * sufficient context to answer the query, helping the system
 * decide whether to fetch more data or proceed with the current set.
 */

import { decisionEngine } from "./engine.js";
import type { ScoredCandidate } from "../rerank/types.js";

/** Maximum number of excerpts to include in the sufficiency check. */
const MAX_EXCERPTS = 3;

/**
 * Evaluate whether the retrieved context adequately addresses the query.
 *
 * Concatenates the query with up to `MAX_EXCERPTS` top candidate excerpts
 * and queries the decision engine to determine if the context is sufficient.
 *
 * @param query - The user's query
 * @param candidateExcerpts - Array of candidate excerpts (already scored/ranked)
 * @returns { satisfied, confidence } indicating whether context is adequate
 */
export async function evaluateSufficiency(
  query: string,
  candidateExcerpts: string[],
): Promise<{ satisfied: boolean; confidence: number }> {
  try {
    // Take top excerpts (up to MAX_EXCERPTS)
    const topExcerpts = candidateExcerpts.slice(0, MAX_EXCERPTS);

    if (topExcerpts.length === 0) {
      return { satisfied: false, confidence: 0.9 };
    }

    // Concatenate query with excerpts
    const concatenatedExcerpts = topExcerpts.join("\n\n---\n\n");

    // Use decision engine to evaluate
    const verdict = await decisionEngine.evaluateVerdict(concatenatedExcerpts, `Does this retrieved context adequately address the query? ${query}`);

    return {
      satisfied: verdict.verdict,
      confidence: verdict.confidence,
    };
  } catch {
    // Fallback: assume sufficient to avoid blocking the pipeline
    return { satisfied: true, confidence: 0.5 };
  }
}

/**
 * Convenience overload: accepts ScoredCandidate[] and extracts excerpts automatically.
 */
export async function evaluateCandidatesSufficiency(
  query: string,
  candidates: ScoredCandidate[],
): Promise<{ satisfied: boolean; confidence: number }> {
  // Extract top candidate excerpts
  const excerpts = candidates
    .slice(0, MAX_EXCERPTS)
    .map((c) => {
      const title = c.title.trim();
      const content = c.content.trim().slice(0, 500);
      return title && content ? `${title}\n${content}` : title || content || " ";
    });

  return evaluateSufficiency(query, excerpts);
}
