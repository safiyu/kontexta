import type { RawEvent } from "../types.js";
import { errorRecoveryDetector } from "./error-recovery.js";
import { explorationDetector } from "./exploration.js";
import { testCycleDetector } from "./test-cycle.js";
import { pivotDetector } from "./pivot.js";
import { buildFailureRecoveryDetector } from "./build-failure-recovery.js";
import { refactorDetector } from "./refactor.js";
import { incidentResponseDetector } from "./incident-response.js";
import { featureDevelopmentDetector } from "./feature-development.js";
import { taggingPassDetector } from "./tagging-pass.js";
import { readOnlyInvestigationDetector } from "./read-only-investigation.js";
import { loadExtraPatterns, type ExtraPatternDef } from "./extra-loader.js";

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
  refactorDetector,
  incidentResponseDetector,
  featureDevelopmentDetector,
  taggingPassDetector,
  readOnlyInvestigationDetector,
];

export function runPatterns(
  events: RawEvent[],
  extraDefs: ExtraPatternDef[] = [],
): PatternMatch[] {
  const extras = loadExtraPatterns(extraDefs);
  const matches: PatternMatch[] = [];
  for (const p of [...builtinPatterns, ...extras]) {
    const m = p.detect(events);
    if (m) matches.push(m);
  }
  return matches;
}

export type { ExtraPatternDef };
