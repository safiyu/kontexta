// packages/core/src/rerank/engine.ts
/**
 * Cross-encoder reranking engine.
 *
 * Loads `Xenova/ms-marco-MiniLM-L-6-v2` via @huggingface/transformers
 * and scores candidate passages using pairwise cross-attention.
 *
 * Always returns `null` on failure — never throws — so callers can
 * fall back to pure BM25 ordering.
 */

import { inferenceRuntime } from "../inference/runtime.js";
import { getModelCacheDir } from "../inference/cache-manager.js";
import type {
  RerankCandidate,
  ScoredCandidate,
  RerankOptions,
  RerankEngineStatus,
} from "./types.js";

/** Default model identifier for reranking. */
const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Default hard timeout per reranking invocation (ms). */
const DEFAULT_TIMEOUT_MS = 300;

/** Maximum number of characters to use from a candidate's content. */
const MAX_CONTENT_CHARS = 1000;

/** Maximum token length for cross-attention. */
const DEFAULT_MAX_LENGTH = 512;

class RerankEngine {
  private modelId: string;
  private maxLength: number;

  constructor(opts?: Partial<RerankOptions>) {
    this.modelId = opts?.model ?? DEFAULT_MODEL;
    this.maxLength = opts?.max_length ?? DEFAULT_MAX_LENGTH;
  }

  /**
   * Rerank a list of BM25 candidates using a cross-encoder model.
   *
   * Each candidate's passage is truncated to title + first 1000 characters.
   * The model produces a raw logit per (query, passage) pair, which is
   * sigmoid-normalized.
   *
   * Returns `null` on any error or timeout (never throws).
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
    opts?: Partial<RerankOptions>,
  ): Promise<ScoredCandidate[] | null> {
    const modelId = opts?.model ?? this.modelId;
    const maxLength = opts?.max_length ?? this.maxLength;
    const timeoutMs = opts?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // Limit candidate pool to avoid blowing the timeout
    const limit = opts?.candidate_limit ?? 30;
    const batch = candidates.slice(0, limit);

    if (batch.length === 0) return null;

    try {
      // Lazy-load the model session (cached after first call)
      const session = await inferenceRuntime.getModelSession({
        modelId,
        timeoutMs,
      });

      // If model failed to load, return null for graceful fallback
      if (!session.instance) return null;

      // Build truncated passages
      const passages = batch.map((c) => this.buildPassage(c));

      let results: number[] | null = null;

      if (
        session.instance &&
        typeof session.instance === "object" &&
        "tokenizer" in session.instance &&
        "model" in session.instance
      ) {
        const { tokenizer, model } = session.instance as { tokenizer: any; model: any };
        const scoreBatch = async (): Promise<number[] | null> => {
          const inputs = tokenizer(
            passages.map(() => query),
            {
              text_pair: passages,
              padding: true,
              truncation: true,
              max_length: maxLength,
            }
          );
          const { logits } = await model(inputs);
          const rawLogits = logits?.data ?? logits?.values ?? [];
          const out: number[] = [];
          for (let i = 0; i < batch.length; i++) {
            const raw = typeof rawLogits[i] === "number" ? rawLogits[i] : rawLogits[i]?.[0] ?? 0;
            if (typeof raw !== "number" || Number.isNaN(raw)) return null;
            out.push(raw);
          }
          return out;
        };

        results = (await this.withTimeout(scoreBatch(), timeoutMs)) ?? null;
      } else if (typeof session.instance === "function") {
        const pipe = session.instance as any;
        const pairs = passages.map((p) => `${query} [SEP] ${p}`);
        results = (await this.withTimeout(this.scoreBatch(pipe, pairs, maxLength), timeoutMs)) ?? null;
      }

      if (!results || results.length === 0) return null;

      // Attach scores to candidates
      const scored: ScoredCandidate[] = batch.map((c, i) => {
        const raw = results![i] ?? 0;
        const sigmoid = this.sigmoid(raw);
        return {
          ...c,
          raw_score: raw,
          sigmoid_score: sigmoid,
          final_score: sigmoid, // arbitrator will adjust this
        };
      });

      return scored;
    } catch {
      // Never throw — return null for fallback
      return null;
    }
  }

  /**
   * Build a truncated passage from a candidate: title + first N chars of content.
   */
  private buildPassage(candidate: RerankCandidate): string {
    const title = candidate.title.trim();
    const content = candidate.content.trim();
    const truncated = content.slice(0, MAX_CONTENT_CHARS);
    if (title && truncated) {
      return `${title}\n\n${truncated}`;
    }
    return title || truncated || " ";
  }

  /**
   * Score a batch of (query, passage) pairs using the feature-extraction pipeline.
   * The cross-encoder produces logits per pair.
   */
  private async scoreBatch(
    pipe: {
      (inputs: string | string[], options?: { max_length?: number; truncation?: boolean }): Promise<any>;
    },
    pairs: string[],
    maxLength: number,
  ): Promise<number[] | null> {
    const results = await pipe(pairs, {
      max_length: maxLength,
      truncation: true,
    });

    // Results is a Tensor — extract scalar logits
    if (results && typeof results === "object") {
      const data = (results as any).data ?? (results as any).values;

      const flat = (Array.isArray(data) ? (Array.isArray(data[0]) ? data.flat() : data) : []) as any[];
      const values: number[] = [];
      for (const v of flat.slice(0, pairs.length)) {
        const n = typeof v === "number" ? v : (Array.isArray(v) ? v[0] : undefined);
        if (typeof n !== "number" || Number.isNaN(n)) return null;
        values.push(n);
      }

      // Not enough numeric logits for the batch — treat as a parse failure.
      if (values.length !== pairs.length) return null;
      return values;
    }

    // Unparseable output — signal failure so callers fall back to BM25.
    return null;
  }

  /**
   * Sigmoid activation function.
   * Maps unbounded logit to [0, 1].
   */
  private sigmoid(x: number): number {
    if (x > 500) return 1;
    if (x < -500) return 0;
    return 1 / (1 + Math.exp(-x));
  }

  /**
   * Wrap a promise with a hard timeout.
   * Returns undefined if the promise does not resolve in time.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<undefined>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Rerank timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Get the current status of the rerank engine.
   */
  getStatus(): RerankEngineStatus {
    const modelStatus = inferenceRuntime.getModelStatus(this.modelId);
    return {
      loaded: modelStatus?.loaded ?? false,
      model: this.modelId,
      cache_dir: modelStatus?.cacheDir ?? getModelCacheDir(),
      device: modelStatus?.device ?? inferenceRuntime.detectDevice(),
    };
  }
}

// Export singleton instance
export const rerankEngine = new RerankEngine();

/**
 * Convenience function to rerank candidates with default settings.
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
  opts?: Partial<RerankOptions>,
): Promise<ScoredCandidate[] | null> {
  return rerankEngine.rerank(query, candidates, opts);
}
