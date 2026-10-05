import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getModelCacheDir } from "./cache-manager.js";

function hasOnnxWeights(modelId: string): boolean {
  const dir = join(getModelCacheDir(), modelId);
  if (!existsSync(dir)) return false;
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).some((f) => f.endsWith(".onnx"));
  } catch {
    return false;
  }
}

/** Download a cross-encoder model into the cache unless its weights are already there. */
export async function ensureModelCached(
  modelId: string,
  log: (msg: string) => void = () => {},
): Promise<"cached" | "downloaded"> {
  if (hasOnnxWeights(modelId)) return "cached";

  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
  env.cacheDir = getModelCacheDir();
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  const seen = new Set<string>();
  const progress_callback = (p: { status?: string; file?: string; progress?: number }) => {
    if (p.status !== "progress" || !p.file || seen.has(p.file)) return;
    seen.add(p.file);
    log(`  downloading ${p.file}`);
  };

  await AutoTokenizer.from_pretrained(modelId, { progress_callback });
  await AutoModelForSequenceClassification.from_pretrained(modelId, { progress_callback });
  return "downloaded";
}
