// packages/core/src/decision/pruning.ts
/**
 * Relevance pruning for candidate filtering.
 *
 * Removes candidates below a minimum relevance threshold
 * before they are passed to the bundle packing stage.
 */

import type { ScoredCandidate } from "../rerank/types.js";

/** Default minimum final_score threshold (logit < -4.0 maps to sigmoid ≈ 0.018). */
const DEFAULT_FLOOR_SCORE = 0.15;

/**
 * Filter out low-relevance candidates below the floor threshold.
 *
 * This is called from bundleSearch to reduce the candidate pool
 * before greedy token packing, preventing noise from consuming
 * the token budget.
 *
 * @param candidates - Reranked and arbitrated candidates
 * @param floorScore - Minimum final_score threshold (default: 0.15)
 * @returns Candidates where final_score >= floorScore, sorted by final_score descending
 */
export function pruneLowRelevanceCandidates(
  candidates: ScoredCandidate[],
  floorScore?: number,
): ScoredCandidate[] {
  const threshold = floorScore ?? DEFAULT_FLOOR_SCORE;

  // If threshold is zero or negative, keep all candidates (sorted by score descending)
  if (threshold <= 0) return [...candidates].sort((a, b) => b.final_score - a.final_score);

  return candidates.filter((c) => c.final_score >= threshold).sort((a, b) => b.final_score - a.final_score);
}
