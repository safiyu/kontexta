// packages/core/src/decision/intent-router.ts
/**
 * Intent router for query classification.
 *
 * Classifies user queries into intent categories and returns the
 * appropriate dictionary_boost for content-class arbitration.
 *
 * Falls back to regex heuristics when the model is unavailable.
 */

import { decisionEngine } from "./engine.js";

/** Intent categories and their dictionary boosts. */
interface IntentMapping {
  intent: string;
  dictionary_boost: number;
  keywords?: string[];
  patterns?: RegExp[];
}

/**
 * Predefined intent categories with heuristic detection rules.
 *
 * - spec_authoritative (+0.15): queries about specifications, architectures,
 *   definitions — authoritative knowledge is highly relevant
 * - troubleshooting_incident (-0.05): error reports, bug fixes — journal
 *   entries and notes may contain more actionable info than dictionary
 * - code_symbol (+0.08): code references with camelCase, snake_case, etc.
 *   — project files and code notes are most relevant
 * - general_exploration (+0.08): default fallback — balanced across sources
 */
const INTENT_CATEGORIES: IntentMapping[] = [
  {
    intent: "spec_authoritative",
    dictionary_boost: 0.15,
    keywords: [
      "spec", "schema", "architecture", "definition", "how it works",
      "design document", "specification", "standard", "protocol",
      "interface contract", "api contract",
    ],
  },
  {
    intent: "troubleshooting_incident",
    dictionary_boost: -0.05,
    keywords: [
      "error", "bug", "fix", "issue", "timeout", "fail", "crash",
      "exception", "stack trace", "debug", "trace", "log",
    ],
  },
  {
    intent: "code_symbol",
    dictionary_boost: 0.0,
    // camelCase, PascalCase, snake_case identifiers
    patterns: [
      /[a-z]+[A-Z][a-zA-Z]+/, // camelCase
      /[A-Z][a-z]+[A-Z]/, // PascalCase
      /[a-z]+_[a-z]+/, // snake_case
    ],
  },
];

/**
 * Route a query to its most likely intent and return the appropriate
 * dictionary_boost for content-class arbitration.
 *
 * @param query - The user's search query
 * @returns { intent, dictionary_boost }
 */
export async function routeQueryIntent(
  query: string,
): Promise<{ intent: string; dictionary_boost: number }> {
  // Try model-based classification first
  const modelResult = await tryModelClassification(query);
  if (modelResult) return modelResult;

  // Fall back to regex heuristics (preserves case for pattern matching)
  return heuristicClassification(query);
}

/**
 * Attempt to classify using the decision engine model.
 * Returns null if model is unavailable.
 */
async function tryModelClassification(
  query: string,
): Promise<{ intent: string; dictionary_boost: number } | null> {
  if (!(await decisionEngine.isAvailable())) {
    return null;
  }

  try {
    const intents = INTENT_CATEGORIES.map((c) => c.intent);
    const result = await decisionEngine.classifyChoice(query, intents);

    // Use the model's selected intent
    const mapping = INTENT_CATEGORIES.find((c) => c.intent === result.selected);
    if (mapping) {
      return {
        intent: result.selected,
        dictionary_boost: mapping.dictionary_boost,
      };
    }
  } catch {
    // Model unavailable, fall through to heuristics
  }
  return null;
}

/**
 * Classify query using regex heuristics.
 * Used as fallback when model is unavailable.
 */
function heuristicClassification(query: string): {
  intent: string;
  dictionary_boost: number;
} {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();

  // Check for code symbols first (most specific pattern, requires original casing)
  for (const cat of INTENT_CATEGORIES) {
    if (cat.patterns) {
      for (const pattern of cat.patterns) {
        if (pattern.test(trimmed)) {
          return { intent: cat.intent, dictionary_boost: cat.dictionary_boost };
        }
      }
    }
  }

  // Check for keyword matches against lowercased query
  for (const cat of INTENT_CATEGORIES) {
    if (cat.keywords) {
      for (const keyword of cat.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return { intent: cat.intent, dictionary_boost: cat.dictionary_boost };
        }
      }
    }
  }

  // Default: general exploration
  return {
    intent: "general_exploration",
    dictionary_boost: 0.08,
  };
}
