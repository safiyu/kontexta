/**
 * Type definitions for the System 1 local inference substrate.
 * Supports cross-encoder reranking (Tier 1) and multi-head decision models (Tier 2).
 */

/** Execution target for ONNX model inference. */
export type ExecutionDevice = "cpu" | "gpu" | "auto" | "wasm";

/**
 * Configuration for loading a single ONNX model from HuggingFace.
 */
export interface ModelRuntimeConfig {
  /** HuggingFace model identifier, e.g. "Xenova/ms-marco-MiniLM-L-6-v2". */
  modelId: string;
  /** Optional subfolder within the repo (rarely needed). */
  subfolder?: string;
  /** Target execution device. Default: "auto". */
  device?: ExecutionDevice;
  /** ONNX weight precision for feature-extraction models; "q8" loads onnx/model_quantized.onnx. Default: the repo's full-precision model.onnx. */
  dtype?: "fp32" | "q8";
  /** Hard timeout in ms for a single inference call. Default: 300. */
  timeoutMs?: number;
  /**
   * Optional cache directory override. Falls back to global cache manager
   * resolution when omitted.
   */
  cacheDir?: string;
}

/**
 * Status snapshot of a loaded model session.
 */
export interface ModelSessionStatus {
  modelId: string;
  loaded: boolean;
  device: string;
  memoryRssBytes: number;
  loadDurationMs: number;
  /** Directory where the model's ONNX weights are cached. */
  cacheDir?: string;
}

/**
 * Tier classification for model usage.
 * Tier 1: Fast pairwise reranker (cross-encoder).
 * Tier 2: Multi-head decision engine (classifier).
 */
export type ModelTier = "tier1-reranker" | "tier2-decision";

/**
 * Registry entry mapping a logical model name to its runtime config and tier.
 */
export interface ModelRegistryEntry {
  name: string;
  config: ModelRuntimeConfig;
  tier: ModelTier;
  /** Whether this model is required for core functionality. Default: false. */
  required?: boolean;
}
