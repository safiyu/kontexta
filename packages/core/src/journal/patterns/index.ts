import type { RawEvent } from "../types.js";
import { errorRecoveryDetector } from "./error-recovery.js";
import { explorationDetector } from "./exploration.js";
import { testCycleDetector } from "./test-cycle.js";
import { pivotDetector } from "./pivot.js";
import { buildFailureRecoveryDetector } from "./build-failure-recovery.js";

export interface PatternMatch {
  name: string;
  summary: string;       // 1-line, e.g. "error-recovery cycle on websocket.ts"
  details: string[];     // bullet points for body
  tags: string[];        // labels added to the entry
}

export interface PatternDetector {
  name: string;
  detect(events: RawEvent[]): PatternMatch | null;
}

export const builtinPatterns: PatternDetector[] = [
  errorRecoveryDetector,
  explorationDetector,
  testCycleDetector,
  pivotDetector,
  buildFailureRecoveryDetector,
];

export function runPatterns(events: RawEvent[], extra: PatternDetector[] = []): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const p of [...builtinPatterns, ...extra]) {
    const m = p.detect(events);
    if (m) matches.push(m);
  }
  return matches;
}
