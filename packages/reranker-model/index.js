import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Root passed to transformers.js as localModelPath; it appends <model id>/<file> itself.
export const modelsDir = join(dirname(fileURLToPath(import.meta.url)), "models");

export function modelDir(id = MODEL_ID) {
  return join(modelsDir, ...id.split("/"));
}
