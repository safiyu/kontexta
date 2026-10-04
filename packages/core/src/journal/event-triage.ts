// packages/core/src/journal/event-triage.ts
/**
 * Event triage for journal entries.
 *
 * Grades events on a 0–4 scale based on their signal value:
 *   0 = noise (low-signal commands like git status)
 *   1 = routine (file edits, dependency checks)
 *   2 = context shift (branch changes, env updates)
 *   3 = high signal (error stacks, test failures)
 *   4 = critical pivot (architectural decisions, abandonments)
 *
 * Falls back to regex heuristics when the model is unavailable.
 */

import { decisionEngine } from "../decision/engine.js";

/** Triage result with continuous score and discrete grade. */
export interface TriageResult {
  /** Continuous score, 0.0–4.0 */
  score: number;
  /** Discrete grade, 0–4 */
  grade: number;
}

/**
 * Triage a journal event and assign a signal grade.
 *
 * @param event - Journal event with type, content, and/or command
 * @returns TriageResult with score and grade
 */
export async function triageEvent(
  event: { type?: string; content?: string; command?: string },
): Promise<TriageResult> {
  const { type, content, command } = event;
  const signal = combineSignal(type, content, command);

  // Try model-based grading first
  const modelResult = await tryModelGrading(signal);
  if (modelResult) return modelResult;

  // Fall back to regex heuristics
  return heuristicGrading(signal);
}

/**
 * Combine all signal sources into a single text string.
 */
function combineSignal(
  type: string | undefined,
  content: string | undefined,
  command: string | undefined,
): string {
  const parts: string[] = [];
  if (type) parts.push(`type: ${type}`);
  if (command) parts.push(`command: ${command}`);
  if (content) parts.push(`content: ${content}`);
  return parts.join(" | ");
}

/**
 * Attempt model-based grading.
 * Returns null if model is unavailable.
 */
async function tryModelGrading(signal: string): Promise<TriageResult | null> {
  // Quick check: if model isn't available, skip immediately
  // so heuristics get a chance to fire.
  if (!(await decisionEngine.isAvailable())) {
    return null;
  }

  try {
    const rating = await decisionEngine.rateScore(signal, "Signal value of this journal event. 0=noise, 1=routine, 2=context shift, 3=high signal, 4=critical pivot.");

    return {
      score: rating.calibrated,
      grade: Math.round(rating.score),
    };
  } catch {
    return null;
  }
}

/**
 * Grade event using regex heuristics.
 * Used as fallback when model is unavailable.
 */
function heuristicGrading(signal: string): TriageResult {
  const lower = signal.toLowerCase();

  // Grade 4: Critical pivots
  if (
    /abandon|rearchitect|rewrite|refactor.*entire|migration.*plan|big.*change|break.*change|architecture.*decision|pivot|deprecate|deprecat|deprecation/i.test(lower)
  ) {
    return { score: 4.0, grade: 4 };
  }

  // Grade 3: High signal (errors, test failures)
  if (
    /error|exception|stack\s*trace|test\s*fai|fail(ure|ed)?|assert|panic|segfault|crash|fatal|critical|blocker|regression/i.test(lower)
  ) {
    return { score: 3.0, grade: 3 };
  }

  // Grade 2: Context shifts
  if (
    /branch\s*change|checkout|env\s*(update|change|set)|config\s*(change|update|mod)|export\s+ENV|dependencies?\s*(add|remove|update|install)|npm\s*(install|link|link|unlink)|yarn\s*(add|remove|unlink)|pnpm\s*(add|remove|unlink)|venv|virtualenv|poetry\s*add|poetry\s*remove|go\s*mod/i.test(lower)
  ) {
    return { score: 2.0, grade: 2 };
  }

  // Grade 1: Routine operations
  if (
    /file\s*edit|create|save|write|update\s*config|dependency|lint|format|build|compile|test\s*pass|test\s*ok|check/i.test(lower)
  ) {
    return { score: 1.0, grade: 1 };
  }

  // Grade 0: Noise
  if (
    /git\s*status|ls\b|pwd|echo|whoami|date|ls\s*-la|cat\s|head\s|tail\s|grep\s|find\b|du\s|df\b/i.test(lower)
  ) {
    return { score: 0.0, grade: 0 };
  }

  // Default: low-signal but not pure noise
  return { score: 0.5, grade: 1 };
}
