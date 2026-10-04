// packages/core/tests/decision/sufficiency.test.ts
import { describe, it, expect } from "vitest";
import { evaluateSufficiency, evaluateCandidatesSufficiency } from "../../src/decision/sufficiency.js";
import type { ScoredCandidate } from "../../src/rerank/types.js";

function makeCandidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    id: 1,
    title: "Test Title",
    path: "/test/path",
    content: "Test content for sufficiency evaluation",
    content_class: null,
    raw_score: 0,
    sigmoid_score: 0.5,
    final_score: 0.5,
    ...overrides,
  };
}

describe("evaluateSufficiency", () => {
  it("returns insufficient for empty excerpts", async () => {
    const result = await evaluateSufficiency("What is the database schema?", []);
    expect(result.satisfied).toBe(false);
    expect(result.confidence).toBe(0.9);
  });

  it("handles single excerpt", async () => {
    const result = await evaluateSufficiency(
      "How does the authentication flow work?",
      ["The authentication flow uses JWT tokens"]
    );
    // Model may or may not be available, should not throw
    expect(typeof result.satisfied).toBe("boolean");
    expect(typeof result.confidence).toBe("number");
  });

  it("handles multiple excerpts", async () => {
    const result = await evaluateSufficiency(
      "What is the API endpoint structure?",
      [
        "GET /api/users returns a list of users",
        "POST /api/users creates a new user",
        "PUT /api/users/:id updates a user",
      ]
    );
    expect(typeof result.satisfied).toBe("boolean");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("handles excerpts longer than 500 chars (truncates)", async () => {
    const longExcerpt = "x".repeat(1000);
    const result = await evaluateSufficiency(
      "Tell me about the code",
      [longExcerpt]
    );
    expect(typeof result.satisfied).toBe("boolean");
  });

  it("does not throw for empty query", async () => {
    await expect(
      evaluateSufficiency("", ["some content"])
    ).resolves.not.toThrow();
  });

  it("does not throw for empty excerpts array", async () => {
    const result = await evaluateSufficiency("query", []);
    expect(result.satisfied).toBe(false);
  });
});

describe("evaluateCandidatesSufficiency", () => {
  it("handles empty candidates array", async () => {
    const result = await evaluateCandidatesSufficiency("query", []);
    expect(result.satisfied).toBe(false);
    expect(result.confidence).toBe(0.9);
  });

  it("extracts excerpts from candidates and evaluates", async () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, title: "Auth Module", content: "JWT authentication flow" }),
      makeCandidate({ id: 2, title: "User Service", content: "User CRUD operations" }),
    ];

    const result = await evaluateCandidatesSufficiency(
      "How does JWT authentication work?",
      candidates
    );

    expect(typeof result.satisfied).toBe("boolean");
  });

  it("handles candidates with empty content", async () => {
    const candidates: ScoredCandidate[] = [
      makeCandidate({ id: 1, title: "Empty", content: "" }),
      makeCandidate({ id: 2, title: "", content: "No title content" }),
    ];

    await expect(
      evaluateCandidatesSufficiency("query", candidates)
    ).resolves.not.toThrow();
  });

  it("does not throw for any input", async () => {
    const candidates: ScoredCandidate[] = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ id: i + 1, title: `Candidate ${i}`, content: `Content ${i}` })
    );

    await expect(
      evaluateCandidatesSufficiency("query", candidates)
    ).resolves.not.toThrow();
  });
});
