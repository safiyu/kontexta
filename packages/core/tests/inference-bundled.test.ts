import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBundledModelsDir } from "../src/inference/bundled.js";

const MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

describe("resolveBundledModelsDir", () => {
  let pkg: string;
  beforeEach(() => { pkg = mkdtempSync(join(tmpdir(), "kx-bundled-")); });
  afterEach(() => { rmSync(pkg, { recursive: true, force: true }); });

  it("returns the models root when onnx weights are present", () => {
    const onnx = join(pkg, "models", "Xenova", "ms-marco-MiniLM-L-6-v2", "onnx");
    mkdirSync(onnx, { recursive: true });
    writeFileSync(join(onnx, "model.onnx"), "x");
    expect(resolveBundledModelsDir(MODEL, pkg)).toBe(join(pkg, "models"));
  });

  it("returns null when the package has only config/tokenizer files", () => {
    const dir = join(pkg, "models", "Xenova", "ms-marco-MiniLM-L-6-v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    expect(resolveBundledModelsDir(MODEL, pkg)).toBeNull();
  });

  it("returns null for a different model id", () => {
    const onnx = join(pkg, "models", "Xenova", "ms-marco-MiniLM-L-6-v2", "onnx");
    mkdirSync(onnx, { recursive: true });
    writeFileSync(join(onnx, "model.onnx"), "x");
    expect(resolveBundledModelsDir("Other/model", pkg)).toBeNull();
  });
});
