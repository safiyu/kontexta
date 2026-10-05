import { inferenceRuntime } from "./runtime.js";
import type { ModelRuntimeConfig } from "./types.js";

export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

const EMBEDDING_CONFIG: ModelRuntimeConfig = {
  modelId: EMBEDDING_MODEL_ID,
  device: "auto",
  dtype: "q8",
  timeoutMs: 10_000,
};

/** Embeds texts into unit-length vectors, or returns null when the model is unavailable. */
export type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

type Extractor = (input: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export const embedTexts: EmbedFn = async (texts) => {
  if (texts.length === 0) return [];
  try {
    const session = await inferenceRuntime.getModelSession(EMBEDDING_CONFIG);
    if (!session.instance) return null;
    const out = await (session.instance as Extractor)(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  } catch {
    return null;
  }
};

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function meanVector(vectors: number[][]): number[] {
  const out = new Array<number>(vectors[0]?.length ?? 0).fill(0);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return out.map((x) => x / vectors.length);
}
