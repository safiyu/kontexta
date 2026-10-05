/**
 * Inference module — shared local inference substrate for System 1 decision models.
 *
 * Provides:
 * - Type definitions for model configurations and sessions
 * - Model cache management with priority-based directory resolution
 * - Singleton inference runtime with lazy loading and graceful fallback
 */

// Types
export type {
  ExecutionDevice,
  ModelRuntimeConfig,
  ModelSessionStatus,
  ModelTier,
  ModelRegistryEntry,
} from "./types.js";

// Cache manager
export {
  getModelCacheDir,
  modelCachePath,
  isModelCachedLocally,
  anyModelsCached,
  setModelCacheDirOverride,
  invalidateModelCache,
  _resetCacheDir,
} from "./cache-manager.js";

// Bundled weights (kontexta-reranker-model)
export { resolveBundledModelsDir } from "./bundled.js";

// Sentence embeddings (journal topic-pivot detection)
export { EMBEDDING_MODEL_ID, embedTexts, cosineSimilarity, meanVector } from "./embeddings.js";
export type { EmbedFn } from "./embeddings.js";

// Runtime singleton
export {
  inferenceRuntime,
  getModel,
  isLoaded,
  getStatus,
  getAllStatuses,
  setInferenceDevice,
  getInferenceDevice,
} from "./runtime.js";
export type { ModelSession } from "./runtime.js";
