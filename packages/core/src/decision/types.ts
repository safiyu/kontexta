// packages/core/src/decision/types.ts
/**
 * Type definitions for the decision engine.
 * Supports choice classification, binary verdicts, and relevance scoring.
 */

/**
 * Result of a multi-option classification decision.
 * `selected` is the chosen option, `confidence` is the model's confidence
 * in the choice (0–1), and `distribution` contains normalized scores
 * for each option to enable downstream arbitration.
 */
export interface ChoiceDecision<T extends string = string> {
  /** The chosen option */
  selected: T;
  /** Confidence in the choice, 0–1 */
  confidence: number;
  /** Normalized scores for all options, enabling tie-breaking or exploration */
  distribution: Record<T, number>;
}

/**
 * Result of a binary yes/no evaluation.
 * `verdict` is the decision, `confidence` is certainty (0–1),
 * and `logit` is the raw model output before sigmoid.
 */
export interface BinaryVerdict {
  /** The binary decision */
  verdict: boolean;
  /** Confidence in the decision, 0–1 */
  confidence: number;
  /** Raw logit output from the model (before sigmoid) */
  logit: number;
}

/**
 * Result of a relevance / quality rating on a 0–4 scale.
 * `score` is a discrete 0–4 rating, `calibrated` is a continuous 0.0–4.0 value.
 */
export interface ScoreRating {
  /** Discrete rating on a 0–4 scale */
  score: number;
  /** Continuous calibrated score, 0.0–4.0 */
  calibrated: number;
}
