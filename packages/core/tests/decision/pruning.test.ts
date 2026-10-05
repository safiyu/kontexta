// packages/core/tests/decision/pruning.test.ts
import { describe, it, expect } from "vitest";
import { pruneLowRelevanceCandidates } from "../../src/decision/pruning.js";
import type { ScoredCandidate } from "../../src/rerank/types.js";

function makeCandidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    id: 1,
    title: "Test",
    path: "/test/path",
    content: "test content",
    content_class: null,
    raw_score: 0,
    sigmoid_score: 0.5,
    final_score: 0.5,
    ...overrides,
  };
}

describe("pruneLowRelevanceCandidates", () => {
  it("returns empty array for empty input", () => {
    expect(pruneLowRelevanceCandidates([])).toEqual([]);
  });

  it("removes candidates below the threshold", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.1 }),   // below 0.15
      makeCandidate({ id: 2, final_score: 0.2 }),   // above 0.15
      makeCandidate({ id: 3, final_score: 0.3 }),   // above 0.15
      makeCandidate({ id: 4, final_score: 0.14 }),  // below 0.15
      makeCandidate({ id: 5, final_score: 0.5 }),   // above 0.15
    ];

    const result = pruneLowRelevanceCandidates(candidates);

    // Filtered to 2, 3, 5 and sorted descending by final_score: 0.5, 0.3, 0.2
    expect(result.map((c) => c.id)).toEqual([5, 3, 2]);
  });

  it("keeps all candidates when threshold is 0", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.01 }),
      makeCandidate({ id: 2, final_score: 0.5 }),
    ];

    const result = pruneLowRelevanceCandidates(candidates, 0);

    expect(result.length).toBe(2);
  });

  it("keeps all candidates when threshold is negative", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.01 }),
      makeCandidate({ id: 2, final_score: 0.5 }),
    ];

    const result = pruneLowRelevanceCandidates(candidates, -0.1);

    expect(result.length).toBe(2);
  });

  it("uses custom threshold when provided", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.2 }),
      makeCandidate({ id: 2, final_score: 0.3 }),
      makeCandidate({ id: 3, final_score: 0.4 }),
    ];

    const result = pruneLowRelevanceCandidates(candidates, 0.25);

    expect(result.map((c) => c.id)).toEqual([3, 2]);
    expect(result[0].final_score).toBeCloseTo(0.4);
    expect(result[1].final_score).toBeCloseTo(0.3);
  });

  it("returns candidates sorted by final_score descending", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.3 }),
      makeCandidate({ id: 2, final_score: 0.9 }),
      makeCandidate({ id: 3, final_score: 0.5 }),
      makeCandidate({ id: 4, final_score: 0.7 }),
    ];

    const result = pruneLowRelevanceCandidates(candidates, 0.1);

    expect(result.map((c) => c.id)).toEqual([2, 4, 3, 1]);
  });

  it("includes candidates exactly at threshold", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.15 }),
      makeCandidate({ id: 2, final_score: 0.149 }),
      makeCandidate({ id: 3, final_score: 0.151 }),
    ];

    const result = pruneLowRelevanceCandidates(candidates, 0.15);

    expect(result.map((c) => c.id)).toEqual([3, 1]);
  });

  it("removes all candidates when threshold is high", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.1 }),
      makeCandidate({ id: 2, final_score: 0.2 }),
    ];

    const result = pruneLowRelevanceCandidates(candidates, 0.5);

    expect(result).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, final_score: 0.1 }),
      makeCandidate({ id: 2, final_score: 0.9 }),
    ];

    const originalOrder = candidates.map((c) => c.id);

    pruneLowRelevanceCandidates(candidates, 0.5);

    // Input should still be in original order
    expect(candidates.map((c) => c.id)).toEqual(originalOrder);
  });
});
