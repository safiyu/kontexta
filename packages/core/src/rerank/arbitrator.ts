// packages/core/src/rerank/arbitrator.ts
/**
 * Soft content-class arbitrator for reranked candidates.
 *
 * After cross-encoder scoring, applies a Bayesian prior based on the
 * content class of each candidate to resolve the "Dictionary Trap"
 * where BM25 always favors dictionary entries regardless of relevance.
 *
 * The arbitration is additive (not multiplicative) to preserve the
 * relative ranking within each class while allowing cross-class
 * reordering when scores are close.
 */

import type { ScoredCandidate } from "./types.js";

/**
 * Beta coefficients for content-class priors.
 *
 * - dictionary: +0.08 — authoritative KB content gets a small boost
 * - note: 0.0 — neutral, no prior adjustment
 * - journal: -0.02 — journal entries are ephemeral, slight penalty
 * - project: 0.0 — neutral, no prior adjustment
 * - null/unknown: 0.0 — default
 */
const CLASS_PRIORS: Record<string, number> = {
  dictionary: 0.08,
  note: 0.0,
  journal: -0.02,
  project: 0.0,
  default: 0.0,
};

/**
 * Arbitrate reranked candidates by adding class-specific Bayesian priors.
 *
 * For each candidate:
 *   final_score = sigmoid_score + β(content_class) + dictionary_boost
 *
 * Candidates are then sorted descending by final_score.
 *
 * @param scored - Array of candidates already scored by the cross-encoder
 * @param opts - Optional overrides
 * @param opts.dictionary_boost - Additional boost for dictionary class (default: 0.08 from CLASS_PRIORS)
 * @returns New array sorted by final_score descending (does not mutate input)
 */
export function arbitrateCandidates(
  scored: ScoredCandidate[],
  opts?: { dictionary_boost?: number },
): ScoredCandidate[] {
  // If empty, return as-is (no sorting needed)
  if (scored.length === 0) return [];

  const dictionaryBoost = opts?.dictionary_boost ?? CLASS_PRIORS.dictionary;

  // Deep copy to avoid mutating the input
  const enriched = scored.map((c) => {
    // Get the class prior
    const contentClass = c.content_class ?? "default";
    const basePrior =
      Object.hasOwn(CLASS_PRIORS, contentClass)
        ? CLASS_PRIORS[contentClass as keyof typeof CLASS_PRIORS]
        : CLASS_PRIORS.default;

    // For dictionary class, use the configured dictionary boost
    const beta =
      contentClass === "dictionary"
        ? dictionaryBoost
        : basePrior;

    const finalScore = c.sigmoid_score + beta;

    return {
      ...c,
      final_score: finalScore,
    };
  });

  // Sort descending by final_score
  enriched.sort((a, b) => b.final_score - a.final_score);

  return enriched;
}
