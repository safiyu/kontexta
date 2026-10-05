import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

// Root passed to transformers.js as localModelPath; it appends <MODEL_ID>/<file> itself.
export const modelsDir = join(dirname(fileURLToPath(import.meta.url)), "models");

export function modelDir() {
  return join(modelsDir, ...MODEL_ID.split("/"));
}
