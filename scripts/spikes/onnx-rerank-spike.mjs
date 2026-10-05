// scripts/spikes/onnx-rerank-spike.mjs
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@huggingface/transformers";

// Configure local model cache
const cacheDir = resolve(process.cwd(), ".cache/models");
env.cacheDir = cacheDir;
// Allow local files first, remote if not present
env.allowLocalModels = true;
env.allowRemoteModels = true;

console.log("=== ONNX Cross-Encoder Spike ===");
console.log(`Cache dir: ${cacheDir}`);
console.log(`Node version: ${process.version}`);
console.log(`Platform: ${process.platform} (${process.arch})`);

const initialMem = process.memoryUsage().rss / (1024 * 1024);
console.log(`Initial RSS Memory: ${initialMem.toFixed(1)} MB`);

const modelId = "Xenova/ms-marco-MiniLM-L-6-v2";

console.log(`\n[1/4] Loading tokenizer and model: ${modelId} (quantized int8)...`);
const t0 = performance.now();
const tokenizer = await AutoTokenizer.from_pretrained(modelId);
const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
  quantized: true,
});
const loadTime = performance.now() - t0;
const loadedMem = process.memoryUsage().rss / (1024 * 1024);
console.log(`Model loaded in ${loadTime.toFixed(1)} ms. RSS: ${loadedMem.toFixed(1)} MB (Δ ${(loadedMem - initialMem).toFixed(1)} MB)`);

// Sigmoid helper
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Predict relevance scores for query + doc pairs
async function scorePairs(query, docs) {
  const inputs = tokenizer(
    docs.map(() => query),
    {
      text_pair: docs,
      padding: true,
      truncation: true,
      max_length: 512,
    }
  );

  const tStart = performance.now();
  const { logits } = await model(inputs);
  const elapsed = performance.now() - tStart;

  // logits shape is [batch_size, 1] or [batch_size]
  const rawLogits = logits.data;
  const results = [];
  for (let i = 0; i < docs.length; i++) {
    const raw = typeof rawLogits[i] === "number" ? rawLogits[i] : rawLogits[i]?.[0] ?? 0;
    results.push({
      doc: docs[i],
      rawScore: raw,
      sigmoidScore: sigmoid(raw),
    });
  }

  return { results, elapsedMs: elapsed };
}

console.log("\n[2/4] Testing Cold-Start vs Warm Scoring...");
const testQuery = "why did the redis connection timeout during staging deployment?";
const testDocs = [
  "Incident Postmortem (2026-09-12): Redis connection timeout during staging deployment was caused by reaching the 10,000 maxclients connection limit during container rollover.",
  "Runbook: Redis Configuration and Best Practices. Outlines port 6379 defaults, sentinel topology, and authentication password parameters.",
  "Architecture Note: User authentication flow and JWT cookie rotation policy in the API gateway.",
  "Meeting Notes: Sprint planning for Q4 design system migration and frontend refactoring.",
];

// Warm up / cold run
const cold = await scorePairs(testQuery, [testDocs[0]]);
console.log(`Cold single-pair inference: ${cold.elapsedMs.toFixed(2)} ms`);

// Test realistic batch
console.log("\n[3/4] Testing Realistic Batch Scoring (Query vs Candidate Passages)...");
const warm = await scorePairs(testQuery, testDocs);
console.log(`Scored ${testDocs.length} candidates in ${warm.elapsedMs.toFixed(2)} ms (${(warm.elapsedMs / testDocs.length).toFixed(2)} ms/item)`);

console.log("\nRelevance Results:");
warm.results.forEach((r, idx) => {
  console.log(`  [Doc ${idx + 1}] Sigmoid: ${r.sigmoidScore.toFixed(4)} | Raw: ${r.rawScore.toFixed(2)}`);
  console.log(`          Excerpt: "${r.doc.slice(0, 85)}..."`);
});

// Test 30 candidate batch to verify CPU latency budget
console.log("\n[4/4] Testing 30-Candidate Batch Latency (Simulation of FTS5 Candidate Pool)...");
const candidate30 = Array.from({ length: 30 }, (_, i) => {
  return `Candidate document passage #${i + 1}: ${testDocs[i % testDocs.length]}`;
});

const batch30 = await scorePairs(testQuery, candidate30);
console.log(`Scored 30 candidates in ${batch30.elapsedMs.toFixed(2)} ms (${(batch30.elapsedMs / 30).toFixed(2)} ms/item)`);

const finalMem = process.memoryUsage().rss / (1024 * 1024);
console.log(`\nFinal RSS Memory: ${finalMem.toFixed(1)} MB (Total Δ ${(finalMem - initialMem).toFixed(1)} MB)`);

// Verification assertions
const topHit = warm.results.reduce((prev, curr) => (curr.sigmoidScore > prev.sigmoidScore ? curr : prev));
const isIncidentTop = topHit.doc.includes("Incident Postmortem");
console.log(`\nVerification: Did Incident Note beat Generic Runbook? ${isIncidentTop ? "YES (SUCCESS)" : "NO"}`);
if (batch30.elapsedMs < 300) {
  console.log(`Verification: 30-item batch within 300ms budget? YES (${batch30.elapsedMs.toFixed(1)} ms)`);
} else {
  console.log(`Verification: 30-item batch within 300ms budget? NO (${batch30.elapsedMs.toFixed(1)} ms)`);
}
