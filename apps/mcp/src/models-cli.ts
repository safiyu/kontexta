#!/usr/bin/env node
// Prefetches the reranker model so `kontexta start` serves with it ready; failures are non-fatal for the caller.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDataDir, setModelCacheDirOverride, ensureModelCached, DEFAULT_MODEL } from "kxta-core";

interface Cfg { search?: { rerank?: { enabled?: boolean; model?: string } }; system1?: { cache_dir?: string } }

function readConfig(): Cfg {
  for (const p of [`${getDataDir()}/kontexta.json`, `${process.cwd()}/kontexta.json`]) {
    if (!existsSync(p)) continue;
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* try next */ }
  }
  return {};
}

export async function runModelsCli(argv: string[]): Promise<number> {
  if (argv[0] !== "ensure") { process.stderr.write("Usage: kontexta-models ensure\n"); return 2; }
  const cfg = readConfig();
  if (cfg.search?.rerank?.enabled === false) return 0;
  if (cfg.system1?.cache_dir) setModelCacheDirOverride(resolve(process.cwd(), cfg.system1.cache_dir));
  const model = cfg.search?.rerank?.model ?? DEFAULT_MODEL;
  let announced = false;
  try {
    const log = (m: string) => process.stdout.write(m + "\n");
    const state = await ensureModelCached(model, (m) => { if (!announced) { log(`Downloading reranker model ${model} (first run only)...`); announced = true; } log(m); });
    if (state === "downloaded") log("Reranker model ready.");
    return 0;
  } catch (e: any) {
    process.stderr.write(`reranker model unavailable (${e?.message ?? e}); search falls back to BM25 order\n`);
    return 1;
  }
}

runModelsCli(process.argv.slice(2)).then((code) => process.exit(code));
