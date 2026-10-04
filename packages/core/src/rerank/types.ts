// packages/core/src/rerank/types.ts
import type { ContentClass } from "../types.js";

export interface RerankCandidate {
  id: number;
  title: string;
  path: string;
  content: string;
  content_class: ContentClass | null;
  /** Owning project (null for Knowledge Base files). */
  project_id?: number | null;
  bm25_rank?: number;
}

export interface ScoredCandidate extends RerankCandidate {
  raw_score: number;       // Raw cross-encoder logit output
  sigmoid_score: number;   // Sigmoid-normalized score in [0, 1]
  final_score: number;     // Soft-arbitrated score incorporating class prior
}

export interface RerankOptions {
  /**
   * Hugging Face model identifier for quantized ONNX cross-encoder.
   * Default: "Xenova/ms-marco-MiniLM-L-6-v2"
   */
  model?: string;
  /**
   * Maximum candidate pool size retrieved from BM25 to score.
   * Default: 30
   */
  candidate_limit?: number;
  /**
   * Additive authority boost for dictionary items on the [0, 1] scale.
   * Default: 0.08
   */
  dictionary_boost?: number;
  /**
   * Reranking operation hard timeout in milliseconds.
   * Default: 300
   */
  timeout_ms?: number;
  /**
   * Maximum token length per document passage for cross-attention.
   * Default: 512
   */
  max_length?: number;
}

export interface RerankEngineStatus {
  loaded: boolean;
  model: string;
  cache_dir: string;
  device: string;
}
