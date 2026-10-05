#!/usr/bin/env node
// Downloads the pinned model files into models/ and verifies them; exits non-zero on any mismatch so a publish never ships half a model.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";
const COMMIT = "a09144355adeed5f58c8ed011d209bf8ee5a1fec";
const FILES = [
  { path: "config.json", size: 824, sha256: "d827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e" },
  { path: "tokenizer.json", size: 711396, sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
  { path: "tokenizer_config.json", size: 1242, sha256: "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53" },
  { path: "onnx/model.onnx", size: 90992115, sha256: "c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870" },
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "models", ...MODEL_ID.split("/"));

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isValid(dest, want) {
  return existsSync(dest) && statSync(dest).size === want.size && sha256Of(dest) === want.sha256;
}

async function download(want) {
  const dest = join(root, want.path);
  if (isValid(dest, want)) {
    console.log(`  ok        ${want.path}`);
    return;
  }
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${COMMIT}/${want.path}`;
  console.log(`  fetching  ${want.path} (${(want.size / 1e6).toFixed(1)} MB)`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${want.path}: HTTP ${res.status} from ${res.url || url}`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (!isValid(tmp, want)) {
    unlinkSync(tmp);
    throw new Error(`${want.path}: size or sha256 mismatch after download`);
  }
  renameSync(tmp, dest);
}

console.log(`kontexta-reranker-model: ensuring ${MODEL_ID}@${COMMIT.slice(0, 7)} in ${root}`);
try {
  for (const f of FILES) await download(f);
  console.log("kontexta-reranker-model: all files present and verified");
} catch (e) {
  console.error(`kontexta-reranker-model: ${e.message}`);
  console.error("The weights are fetched from huggingface.co; corporate proxies (e.g. Zscaler) may block the CDN redirect. Run this on a network that can reach it.");
  process.exit(1);
}
