/**
 * Inference Runtime — singleton manager for ONNX model lifecycles.
 *
 * Responsibilities:
 *   1. Initialize @huggingface/transformers environment variables
 *   2. Select execution device (auto-detect CPU vs GPU)
 *   3. Lazy-load models on first inference call
 *   4. Handle graceful teardown via beforeExit hooks
 */

import type { ModelRuntimeConfig, ModelSessionStatus, ExecutionDevice } from "./types.js";
import { getModelCacheDir, modelCachePath, isModelCachedLocally, invalidateModelCache } from "./cache-manager.js";
import { resolveBundledModelsDir } from "./bundled.js";

/**
 * Runtime state for a single loaded model.
 */
export interface ModelSession {
  config: ModelRuntimeConfig;
  device: string;
  /** Cache directory the model was resolved from. */
  cacheDir: string;
  loadedAt: number;
  memoryRssBytes: number;
  /** Lazy-loaded model instance (ONNX runtime object, tokenizer/model pair, or transformers pipeline). */
  instance: unknown;
}

/**
 * Default timeout for inference operations (milliseconds).
 */
const DEFAULT_TIMEOUT_MS = 300;

/**
 * Default device when user specifies "auto".
 */
const DEFAULT_AUTO_DEVICE: ExecutionDevice = "cpu";

/**
 * Configured execution device (from `system1.device` in kontexta.json).
 * When set to a concrete device it is used directly; "auto" falls through to
 * detection.
 */
let _configuredDevice: ExecutionDevice | null = null;

/**
 * Set (or clear) the configured execution device.
 */
export function setInferenceDevice(device: ExecutionDevice | null): void {
  _configuredDevice = device && device !== "auto" ? device : null;
}

/**
 * Get the configured execution device, if any.
 */
export function getInferenceDevice(): ExecutionDevice | null {
  return _configuredDevice;
}

class InferenceRuntime {
  private static _instance: InferenceRuntime | null = null;
  private _sessions: Map<string, ModelSession> = new Map();
  private _initialized = false;
  private _teardownRegistered = false;

  /**
   * Get the singleton instance.
   */
  static get instance(): InferenceRuntime {
    if (!InferenceRuntime._instance) {
      InferenceRuntime._instance = new InferenceRuntime();
    }
    return InferenceRuntime._instance;
  }

  private constructor() {
    // Initialize transformers environment on first access
    if (!this._initialized) {
      this.initialize();
    }
  }

  /**
   * Initialize the inference runtime.
   * Sets up transformers environment variables and device selection.
   */
  initialize(): void {
    if (this._initialized) return;

    // Configure @huggingface/transformers to use our cache directory
    const cacheDir = getModelCacheDir();

    // These environment variables control the HF transformers library behavior
    if (!process.env.HF_HOME) {
      process.env.HF_HOME = cacheDir;
    }
    if (!process.env.TRANSFORMERS_CACHE) {
      process.env.TRANSFORMERS_CACHE = cacheDir;
    }
    if (!process.env.HUGGINGFACE_HUB_CACHE) {
      process.env.HUGGINGFACE_HUB_CACHE = cacheDir;
    }

    // Disable remote model downloads telemetry
    process.env.HF_HUB_DISABLE_TELEMETRY = "1";

    this._initialized = true;

    // Register teardown hook if not already done
    if (!this._teardownRegistered) {
      this._teardownRegistered = true;
      process.on("beforeExit", () => this.shutdown());
    }
  }

  /**
   * Detect the best available execution device.
   * Returns the configured device (from `system1.device`) when set, otherwise
   * defaults to "cpu" — GPU detection can be added later.
   */
  detectDevice(): ExecutionDevice {
    return _configuredDevice ?? DEFAULT_AUTO_DEVICE;
  }

  /**
   * Resolve the final device for a model config.
   * Merges user-specified device with auto-detection.
   */
  resolveDevice(config: ModelRuntimeConfig): string {
    const device = config.device ?? "auto";

    if (device === "auto") {
      return this.detectDevice();
    }

    return device;
  }

  /**
   * Get or lazily load a model session.
   *
   * @param config - Model configuration
   * @returns The loaded model session
   */
  async getModelSession(config: ModelRuntimeConfig): Promise<ModelSession> {
    // Return cached session if available
    const existing = this._sessions.get(config.modelId);
    if (existing) return existing;

    const device = this.resolveDevice(config);
    const cacheDir = config.cacheDir ?? getModelCacheDir();
    const startTime = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const modelInstance = await this.loadModel(config, device);

      const loadDuration = Date.now() - startTime;
      const memoryRss = this.getProcessMemoryRss();

      const session: ModelSession = {
        config,
        device,
        cacheDir,
        loadedAt: startTime,
        memoryRssBytes: memoryRss,
        instance: modelInstance,
      };

      this._sessions.set(config.modelId, session);
      return session;
    } catch (error) {
      // If model fails to load (missing, corrupt, etc.), do NOT throw.
      // Return a null session to signal the caller to fall back to heuristics.
      console.warn(
        `[InferenceRuntime] Failed to load model ${config.modelId}: ${error instanceof Error ? error.message : String(error)}`
      );

      const failedSession: ModelSession = {
        config,
        device,
        cacheDir,
        loadedAt: startTime,
        memoryRssBytes: 0,
        instance: null,
      };

      this._sessions.set(config.modelId, failedSession);
      return failedSession;
    }
  }

  /**
   * Load a specific model instance based on config.
   * Handles different model types (cross-encoder, classifier, etc.).
   */
  private async loadModel(
    config: ModelRuntimeConfig,
    device: string
  ): Promise<unknown> {
    const { AutoTokenizer, AutoModelForSequenceClassification, pipeline, env } = await import("@huggingface/transformers");

    env.cacheDir = config.cacheDir ?? getModelCacheDir();
    env.allowLocalModels = true;
    const bundled = resolveBundledModelsDir(config.modelId);
    if (bundled) {
      env.localModelPath = bundled;
      env.allowRemoteModels = false;
    } else {
      env.allowRemoteModels = true;
    }

    // Set device preference for transformers
    if (device === "cpu" && env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1; // Avoid CPU starvation
    }

    // Sequence classification / cross-encoder model
    if (
      config.modelId.includes("ms-marco") ||
      config.modelId.includes("rerank") ||
      config.subfolder === "cross-encoder"
    ) {
      const tokenizer = await AutoTokenizer.from_pretrained(config.modelId);
      const model = await AutoModelForSequenceClassification.from_pretrained(config.modelId);
      return { tokenizer, model, type: "cross-encoder" };
    }

    // Default pipeline fallback
    const modelInstance = await pipeline(
      "feature-extraction",
      config.modelId,
      {
        progress_callback: () => {},
        ...(config.dtype ? { dtype: config.dtype } : {}),
      }
    );

    return modelInstance;
  }

  /**
   * Get the current RSS memory usage of this Node.js process.
   */
  private getProcessMemoryRss(): number {
    try {
      if (process.memoryUsage) {
        return process.memoryUsage().rss;
      }
    } catch {
      // Fallback if memoryUsage is unavailable (unlikely in Node.js)
    }
    return 0;
  }

  /**
   * Get the status of a loaded model.
   */
  getModelStatus(modelId: string): ModelSessionStatus | null {
    const session = this._sessions.get(modelId);
    if (!session) return null;

    return {
      modelId,
      loaded: session.instance !== null,
      device: session.device,
      memoryRssBytes: session.memoryRssBytes,
      loadDurationMs: Date.now() - session.loadedAt,
      cacheDir: session.cacheDir,
    };
  }

  /**
   * Check if a specific model is loaded and available.
   */
  isModelLoaded(modelId: string): boolean {
    const session = this._sessions.get(modelId);
    return session !== undefined && session.instance !== null && session.instance !== undefined;
  }

  /**
   * Get all loaded model statuses.
   */
  getAllModelStatuses(): ModelSessionStatus[] {
    const statuses: ModelSessionStatus[] = [];

    for (const [modelId] of this._sessions) {
      const status = this.getModelStatus(modelId);
      if (status) statuses.push(status);
    }

    return statuses;
  }

  /**
   * Get the number of currently loaded models.
   */
  get loadedCount(): number {
    return this._sessions.size;
  }

  /**
   * Shutdown and clean up all model sessions.
   */
  shutdown(): void {
    for (const [modelId, session] of this._sessions) {
      try {
        // Attempt to dispose model resources
        if (session.instance && typeof session.instance === "object" && "dispose" in session.instance) {
          const disposeFn = (session.instance as { dispose: () => void }).dispose;
          if (typeof disposeFn === "function") {
            disposeFn();
          }
        }
      } catch {
        // Best-effort cleanup — don't throw during shutdown
      }
    }

    this._sessions.clear();
    this._initialized = false;
  }

  /**
   * Clear a specific model from cache (force reload next time).
   */
  clearModelCache(modelId: string): void {
    this._sessions.delete(modelId);
    invalidateModelCache(modelId);
  }

  /**
   * Clear all model sessions (useful for testing or hot-reload).
   */
  clearAllSessions(): void {
    this.shutdown();
  }
}

/**
 * Export singleton instance for use throughout the codebase.
 */
export const inferenceRuntime = InferenceRuntime.instance;

/**
 * Convenience function to get a model session.
 *
 * @example
 * ```typescript
 * const session = await getModel("Xenova/ms-marco-MiniLM-L-6-v2");
 * if (session.instance) {
 *   // Use the model
 * }
 * ```
 */
export async function getModel(config: ModelRuntimeConfig): Promise<ModelSession> {
  return InferenceRuntime.instance.getModelSession(config);
}

/**
 * Check if a model is loaded.
 */
export function isLoaded(modelId: string): boolean {
  return InferenceRuntime.instance.isModelLoaded(modelId);
}

/**
 * Get model status.
 */
export function getStatus(modelId: string): ModelSessionStatus | null {
  return InferenceRuntime.instance.getModelStatus(modelId);
}

/**
 * Get all model statuses.
 */
export function getAllStatuses(): ModelSessionStatus[] {
  return InferenceRuntime.instance.getAllModelStatuses();
}
