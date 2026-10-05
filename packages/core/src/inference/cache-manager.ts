/**
 * Model Cache Manager — resolves local cache directories for ONNX model weights
 * and provides integrity checks before attempting online downloads.
 *
 * Resolution order:
 *   1. $KONTEXTA_MODEL_CACHE environment variable (if set)
 *   2. <dataDir>/models  (where dataDir comes from util/paths.ts)
 *   3. ~/.cache/kontexta/models
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "../util/paths.js";

let _cacheDir: string | null = null;
/**
 * Explicit cache-dir override (highest precedence), set from
 * `system1.cache_dir` in kontexta.json. Relative paths are resolved against
 * the current working directory.
 */
let _overrideDir: string | null = null;

/**
 * Set (or clear, when `dir` is null) an explicit model cache directory.
 * Takes precedence over the environment and data-dir resolution order.
 */
export function setModelCacheDirOverride(dir: string | null): void {
  _overrideDir = dir && dir.trim() ? dir : null;
  // The override changes resolution; force re-resolution on next access.
  _cacheDir = null;
}

/**
 * Resolve the canonical model cache directory.
 * Caches the result on first call.
 */
function resolveCacheDir(): string {
  if (_cacheDir) return _cacheDir;

  // Priority 0: explicit runtime override (system1.cache_dir)
  if (_overrideDir) {
    _cacheDir = _overrideDir;
    mkdirSync(_cacheDir, { recursive: true });
    return _cacheDir;
  }

  // Priority 1: explicit env override
  const envCache = process.env.KONTEXTA_MODEL_CACHE;
  if (envCache) {
    _cacheDir = envCache;
    mkdirSync(_cacheDir, { recursive: true });
    return _cacheDir;
  }

  // Priority 2: local .cache/models in workspace (if present)
  const localCache = join(process.cwd(), ".cache", "models");
  if (existsSync(localCache)) {
    _cacheDir = localCache;
    return _cacheDir;
  }

  // Priority 3: <dataDir>/models
  const dataDir = getDataDir();
  if (dataDir) {
    _cacheDir = join(dataDir, "models");
    mkdirSync(_cacheDir, { recursive: true });
    return _cacheDir;
  }

  // Priority 4: ~/.cache/kontexta/models
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  _cacheDir = join(home, ".cache", "kontexta", "models");
  mkdirSync(_cacheDir, { recursive: true });
  return _cacheDir;
}

/**
 * Returns the resolved model cache directory path.
 */
export function getModelCacheDir(): string {
  return resolveCacheDir();
}

/**
 * Construct the absolute path where a specific model's weights are stored.
 * Checks both namespaced under HF identifier and safe sanitized name.
 */
export function modelCachePath(modelId: string): string {
  const directPath = join(resolveCacheDir(), modelId);
  if (existsSync(directPath)) return directPath;
  const safeName = modelId.replace(/[\/\\:]/g, "_");
  return join(resolveCacheDir(), safeName);
}

/**
 * Check whether a model appears to be fully cached locally.
 * Verifies the cache directory exists and contains at least one model artifact.
 */
export function isModelCachedLocally(modelId: string): boolean {
  const candidates = [
    join(resolveCacheDir(), modelId),
    join(resolveCacheDir(), modelId.replace(/[\/\\:]/g, "_")),
  ];

  for (const cacheDir of candidates) {
    if (!existsSync(cacheDir)) continue;

    try {
      const items = readdirSync(cacheDir, { recursive: true }) as string[];
      const hasArtifact = items.some(
        (f) =>
          f.endsWith(".safetensors") ||
          f.endsWith(".onnx") ||
          f.endsWith("config.json") ||
          f.endsWith("tokenizer.json")
      );
      if (hasArtifact) return true;
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Check if any of the given model IDs are cached locally.
 */
export function anyModelsCached(modelIds: string[]): boolean {
  return modelIds.some((id) => isModelCachedLocally(id));
}

/**
 * Invalidate (remove) the cache entry for a specific model.
 */
export function invalidateModelCache(modelId: string): void {
  const candidates = [
    join(resolveCacheDir(), modelId),
    join(resolveCacheDir(), modelId.replace(/[\/\\:]/g, "_")),
  ];
  for (const cacheDir of candidates) {
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }
}

/**
 * Reset the internal cache dir singleton (useful for testing).
 */
export function _resetCacheDir(): void {
  _cacheDir = null;
  _overrideDir = null;
}
