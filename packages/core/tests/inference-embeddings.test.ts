import { describe, it, expect } from "vitest";
import { cosineSimilarity, meanVector, embedTexts, EMBEDDING_MODEL_ID, resolveBundledModelsDir } from "../src/inference/index.js";

describe("vector helpers", () => {
  it("cosine is 1 for identical, 0 for orthogonal, 0 for a zero vector", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("meanVector averages component-wise", () => {
    expect(meanVector([[1, 3], [3, 5]])).toEqual([2, 4]);
  });
});

const haveWeights = resolveBundledModelsDir(EMBEDDING_MODEL_ID) !== null;

describe.skipIf(!haveWeights)("embedTexts with the bundled model", () => {
  it("places related text closer than unrelated text", async () => {
    const v = await embedTexts(["how do I roll back a database migration", "undo a failed schema change", "descale the office coffee machine"]);
    expect(v).not.toBeNull();
    const [q, related, unrelated] = v!;
    expect(cosineSimilarity(q, related)).toBeGreaterThan(cosineSimilarity(q, unrelated));
  }, 60_000);
});
