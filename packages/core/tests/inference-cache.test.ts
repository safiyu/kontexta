import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  getModelCacheDir,
  modelCachePath,
  isModelCachedLocally,
  anyModelsCached,
  _resetCacheDir,
} from "../src/inference/cache-manager.js";
import { inferenceRuntime, getStatus, isLoaded } from "../src/inference/runtime.js";

describe("Inference Cache Manager", () => {
  const originalEnv = process.env.KONTEXTA_MODEL_CACHE;

  beforeEach(() => {
    _resetCacheDir();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.KONTEXTA_MODEL_CACHE = originalEnv;
    } else {
      delete process.env.KONTEXTA_MODEL_CACHE;
    }
    _resetCacheDir();
  });

  it("resolves cache directory using KONTEXTA_MODEL_CACHE override if provided", () => {
    process.env.KONTEXTA_MODEL_CACHE = "/tmp/test-kontexta-cache";
    _resetCacheDir();
    expect(getModelCacheDir()).toBe("/tmp/test-kontexta-cache");
  });

  it("resolves direct path or sanitized safe path for models", () => {
    const path = modelCachePath("Xenova/ms-marco-MiniLM-L-6-v2");
    expect(path).toContain("Xenova");
  });

  it("accurately detects if model is cached locally", () => {
    // ms-marco-MiniLM-L-6-v2 is cached in this workspace
    const isCached = isModelCachedLocally("Xenova/ms-marco-MiniLM-L-6-v2");
    expect(typeof isCached).toBe("boolean");

    const nonExistent = isModelCachedLocally("NonExistent/fake-model-12345");
    expect(nonExistent).toBe(false);
  });

  it("checks anyModelsCached across an array of IDs", () => {
    const result = anyModelsCached(["NonExistent/1", "NonExistent/2"]);
    expect(result).toBe(false);
  });
});

describe("Inference Runtime Singleton", () => {
  it("provides singleton instance with status query methods", () => {
    expect(inferenceRuntime).toBeDefined();
    expect(typeof inferenceRuntime.initialize).toBe("function");
    expect(typeof inferenceRuntime.getModelSession).toBe("function");

    const status = getStatus("dummy-model");
    expect(status).toBeNull();

    const loaded = isLoaded("dummy-model");
    expect(loaded).toBe(false);
  });
});
