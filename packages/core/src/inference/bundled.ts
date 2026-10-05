import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PACKAGE = "kontexta-reranker-model";

function hasOnnx(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".onnx"));
  } catch {
    return false;
  }
}

/** Models root of the installed kontexta-reranker-model package, or null when it is absent or lacks weights for `modelId`. */
export function resolveBundledModelsDir(modelId: string, packageDir?: string): string | null {
  let dir = packageDir;
  if (!dir) {
    try {
      dir = dirname(createRequire(import.meta.url).resolve(`${PACKAGE}/package.json`));
    } catch {
      return null;
    }
  }
  const modelsDir = join(dir, "models");
  return hasOnnx(join(modelsDir, ...modelId.split("/"), "onnx")) ? modelsDir : null;
}
