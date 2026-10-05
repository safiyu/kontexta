// packages/core/tests/rerank/arbitrator.test.ts
import { describe, it, expect } from "vitest";
import { arbitrateCandidates } from "../../src/rerank/arbitrator.js";
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

describe("arbitrateCandidates", () => {
  it("returns empty array for empty input", () => {
    expect(arbitrateCandidates([])).toEqual([]);
  });

  it("applies dictionary boost correctly", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "dictionary", sigmoid_score: 0.6 }),
      makeCandidate({ id: 2, content_class: "note", sigmoid_score: 0.55 }),
    ];

    const result = arbitrateCandidates(candidates, { dictionary_boost: 0.08 });

    // Dictionary: 0.6 + 0.08 = 0.68
    // Note: 0.55 + 0.0 = 0.55
    expect(result[0].final_score).toBeCloseTo(0.68);
    expect(result[1].final_score).toBeCloseTo(0.55);
    // Dictionary should be ranked first
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it("reorders candidates when boost changes ranking", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "note", sigmoid_score: 0.7 }),
      makeCandidate({ id: 2, content_class: "dictionary", sigmoid_score: 0.65 }),
    ];

    const result = arbitrateCandidates(candidates);

    // Note: 0.7 + 0.0 = 0.7
    // Dictionary: 0.65 + 0.08 = 0.73
    // Dictionary should now be first
    expect(result[0].id).toBe(2);
    expect(result[0].final_score).toBeCloseTo(0.73);
    expect(result[1].id).toBe(1);
    expect(result[1].final_score).toBeCloseTo(0.7);
  });

  it("applies negative penalty to journal entries", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "journal", sigmoid_score: 0.5 }),
      makeCandidate({ id: 2, content_class: "note", sigmoid_score: 0.48 }),
    ];

    const result = arbitrateCandidates(candidates);

    // Journal: 0.5 + (-0.02) = 0.48
    // Note: 0.48 + 0.0 = 0.48
    expect(result[0].id).toBe(1);
    expect(result[0].final_score).toBeCloseTo(0.48);
  });

  it("uses custom dictionary_boost when provided", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "dictionary", sigmoid_score: 0.5 }),
    ];

    const result = arbitrateCandidates(candidates, { dictionary_boost: 0.15 });

    expect(result[0].final_score).toBeCloseTo(0.65);
  });

  it("treats null content_class as default (no boost)", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: null, sigmoid_score: 0.5 }),
    ];

    const result = arbitrateCandidates(candidates);

    expect(result[0].final_score).toBeCloseTo(0.5);
  });

  it("does not mutate input array", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "dictionary", sigmoid_score: 0.5 }),
      makeCandidate({ id: 2, content_class: "note", sigmoid_score: 0.6 }),
    ];

    const originalScores = candidates.map((c) => c.final_score);

    arbitrateCandidates(candidates);

    // Input should not be mutated
    candidates.forEach((c, i) => {
      expect(c.final_score).toBe(originalScores[i]);
    });
  });

  it("sorts descending by final_score", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "note", sigmoid_score: 0.3 }),
      makeCandidate({ id: 2, content_class: "dictionary", sigmoid_score: 0.5 }),
      makeCandidate({ id: 3, content_class: "journal", sigmoid_score: 0.4 }),
    ];

    const result = arbitrateCandidates(candidates);

    expect(result[0].id).toBe(2); // dictionary: 0.5 + 0.08 = 0.58
    expect(result[1].id).toBe(3); // journal: 0.4 - 0.02 = 0.38
    expect(result[2].id).toBe(1); // note: 0.3 + 0.0 = 0.3
  });

  it("handles project content class (neutral boost)", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "project", sigmoid_score: 0.5 }),
    ];

    const result = arbitrateCandidates(candidates);

    expect(result[0].final_score).toBeCloseTo(0.5);
  });

  it("treats unrecognized custom content_class as the default prior (no boost)", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "unknown_custom_class" as never, sigmoid_score: 0.5 }),
      makeCandidate({ id: 2, content_class: "journal", sigmoid_score: 0.49 }),
    ];

    const result = arbitrateCandidates(candidates);

    // unknown: 0.5 + 0.0 (default) = 0.5 ; journal: 0.49 - 0.02 = 0.47
    expect(result[0].id).toBe(1);
    expect(result[0].final_score).toBeCloseTo(0.5);
    expect(result[1].final_score).toBeCloseTo(0.47);
  });

  it("preserves all candidate fields through arbitration", () => {
    const candidate = makeCandidate({
      id: 42,
      content_class: "dictionary",
      sigmoid_score: 0.7,
      raw_score: -2.5,
    });

    const result = arbitrateCandidates([candidate]);

    expect(result[0].id).toBe(42);
    expect(result[0].content_class).toBe("dictionary");
    expect(result[0].sigmoid_score).toBeCloseTo(0.7);
    expect(result[0].raw_score).toBe(-2.5);
    expect(result[0].final_score).toBeCloseTo(0.78);
  });

  it("threshold 0 keeps all candidates sorted", () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, content_class: "note", sigmoid_score: 0.3 }),
      makeCandidate({ id: 2, content_class: "dictionary", sigmoid_score: 0.9 }),
    ];

    const result = arbitrateCandidates(candidates);

    expect(result.length).toBe(2);
    expect(result[0].id).toBe(2); // 0.9 + 0.08 = 0.98
    expect(result[1].id).toBe(1); // 0.3
  });
});
