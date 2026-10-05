import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModelCached, setModelCacheDirOverride } from "../src/inference/index.js";

describe("ensureModelCached", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kx-models-")); setModelCacheDirOverride(dir); });
  afterEach(() => { setModelCacheDirOverride(null); rmSync(dir, { recursive: true, force: true }); });

  it("skips the download when onnx weights are already cached", async () => {
    mkdirSync(join(dir, "Xenova", "m", "onnx"), { recursive: true });
    writeFileSync(join(dir, "Xenova", "m", "onnx", "model.onnx"), "x");
    expect(await ensureModelCached("Xenova/m")).toBe("cached");
  });
});
