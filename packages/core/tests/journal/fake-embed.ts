import type { EmbedFn } from "../../src/inference/embeddings.js";

// Deterministic bag-of-words vectors: texts sharing words are similar, disjoint texts are about orthogonal.
export const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array<number>(512).fill(0);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      v[Math.abs(h) % 512] += 1;
    }
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  });
