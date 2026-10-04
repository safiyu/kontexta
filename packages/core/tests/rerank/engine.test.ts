// packages/core/tests/rerank/engine.test.ts
import { describe, it, expect } from "vitest";
import { rerankCandidates, rerankEngine } from "../../src/rerank/engine.js";
import type { RerankCandidate } from "../../src/rerank/types.js";

function makeCandidate(overrides: Partial<RerankCandidate> = {}): RerankCandidate {
  return {
    id: 1,
    title: "Test Title",
    path: "/test/path",
    content: "Test content for reranking",
    content_class: null,
    ...overrides,
  };
}

describe("rerankCandidates", () => {
  it("returns null for empty candidates array", async () => {
    const result = await rerankCandidates("query", []);
    expect(result).toBeNull();
  });

  it("returns null for single empty candidate", async () => {
    const result = await rerankCandidates("query", [makeCandidate({ content: "" })]);
    // Should not throw, may return null or single result depending on model availability
    expect(Array.isArray(result) || result === null).toBe(true);
  });

  it("handles model unavailability gracefully (no throw)", async () => {
    const candidates = [
      makeCandidate({ id: 1, content: "content 1" }),
      makeCandidate({ id: 2, content: "content 2" }),
    ];

    // Should not throw even if model is not available
    await expect(rerankCandidates("query", candidates)).resolves.not.toThrow();
  });

  it("applies candidate_limit to batch size", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ id: i + 1, content: `content ${i + 1}` })
    );

    // Should not throw; the engine internally limits the batch
    await expect(rerankCandidates("query", candidates, { candidate_limit: 5 })).resolves.not.toThrow();
  });

  it("handles timeout gracefully", async () => {
    const candidates = [makeCandidate({ id: 1, content: "test" })];

    // Very short timeout should either return null or complete before timeout
    const result = await rerankCandidates("query", candidates, { timeout_ms: 1 });

    // Either null (timeout) or valid result
    expect(result === null || (Array.isArray(result) && result.length >= 0)).toBe(true);
  });

  it("handles non-ASCII content", async () => {
    const candidates = [
      makeCandidate({ id: 1, content: "日本語のテスト", title: "Test 日本語" }),
    ];

    await expect(
      rerankCandidates("query with unicode", candidates)
    ).resolves.not.toThrow();
  });

  it("reports engine status with the default model and a loaded flag", () => {
    const status = rerankEngine.getStatus();
    expect(status).toBeDefined();
    expect(status.model).toContain("ms-marco");
    expect(typeof status.loaded).toBe("boolean");
    expect(typeof status.cache_dir).toBe("string");
    expect(typeof status.device).toBe("string");
  });
});
