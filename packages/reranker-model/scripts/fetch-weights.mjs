#!/usr/bin/env node
// Downloads the pinned model files into models/ and verifies them; exits non-zero on any mismatch so a publish never ships half a model.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MODELS = [
  {
    id: "Xenova/ms-marco-MiniLM-L-6-v2",
    commit: "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
    files: [
      { path: "config.json", size: 824, sha256: "d827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e" },
      { path: "tokenizer.json", size: 711396, sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
      { path: "tokenizer_config.json", size: 1242, sha256: "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53" },
      { path: "onnx/model.onnx", size: 90992115, sha256: "c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870" },
    ],
  },
  {
    id: "Xenova/all-MiniLM-L6-v2",
    commit: "751bff37182d3f1213fa05d7196b954e230abad9",
    files: [
      { path: "config.json", size: 650, sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7" },
      { path: "tokenizer.json", size: 711661, sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0" },
      { path: "tokenizer_config.json", size: 366, sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" },
      { path: "special_tokens_map.json", size: 125, sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3" },
      { path: "onnx/model_quantized.onnx", size: 22972370, sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1" },
    ],
  },
];

const modelsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "models");

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isValid(dest, want) {
  return existsSync(dest) && statSync(dest).size === want.size && sha256Of(dest) === want.sha256;
}

async function download(model, want) {
  const dest = join(modelsRoot, ...model.id.split("/"), want.path);
  if (isValid(dest, want)) {
    console.log(`  ok        ${want.path}`);
    return;
  }
  const url = `https://huggingface.co/${model.id}/resolve/${model.commit}/${want.path}`;
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

try {
  for (const model of MODELS) {
    console.log(`kontexta-reranker-model: ensuring ${model.id}@${model.commit.slice(0, 7)}`);
    for (const f of model.files) await download(model, f);
  }
  console.log("kontexta-reranker-model: all files present and verified");
} catch (e) {
  console.error(`kontexta-reranker-model: ${e.message}`);
  console.error("The weights are fetched from huggingface.co; corporate proxies (e.g. Zscaler) may block the CDN redirect. Run this on a network that can reach it.");
  process.exit(1);
}
