#!/usr/bin/env node
/**
 * token-benchmark.mjs  (v2 — marketing grade)
 * ─────────────────────────────────────────────
 * Measures real token consumption for developer tasks:
 *   • Baseline: files a developer would open without AI assistance
 *   • Kontexta: only files retrieved via MCP tool calls
 *
 * Uses the cl100k_base tokenizer (same as GPT-4 / Claude-equivalent).
 *
 * Usage:
 *   node scripts/token-benchmark.mjs
 *   node scripts/token-benchmark.mjs --scenario auth-implementation
 *   node scripts/token-benchmark.mjs --json > results.json
 */

// We need CommonJS require() for gpt-tokenizer installed locally in scripts/
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { encode } = require("gpt-tokenizer");

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── Helpers ────────────────────────────────────────────────────────────────
const fmt = (n) => n.toLocaleString();
const pct = (a, b) => ((a / b) * 100).toFixed(1);

function countTokens(filePath) {
  const full = join(ROOT, filePath);
  if (!existsSync(full)) return { tokens: 0, error: "file not found" };
  try {
    const content = readFileSync(full, "utf-8");
    return { tokens: encode(content).length, bytes: content.length };
  } catch (e) {
    return { tokens: 0, error: e.message };
  }
}

function printHr(width = 66) { console.log("─".repeat(width)); }

function printTable(rows, alignRight = []) {
  const cols = rows[0].length;
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => String(r[c]).length))
  );
  const sep = "┼" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┼";
  const fmt_row = (row, isHeader) =>
    "│" + row.map((cell, i) => {
      const s = String(cell);
      const pad = widths[i] - s.length;
      return alignRight.includes(i)
        ? " " + " ".repeat(pad) + s + " "
        : " " + s + " ".repeat(pad) + " ";
    }).join("│") + "│";

  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  const mid = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";

  console.log(top);
  rows.forEach((row, i) => {
    console.log(fmt_row(row, i === 0));
    if (i === 0) console.log(mid);
  });
  console.log(bot);
}

// ─── CLI ────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    json:     { type: "boolean", default: false },
  },
  strict: false,
});

const scenariosFile = join(__dirname, "benchmark-scenarios.json");
const config = JSON.parse(readFileSync(scenariosFile, "utf-8"));
const scenarios = values.scenario
  ? config.scenarios.filter((s) => s.id === values.scenario)
  : config.scenarios;

if (scenarios.length === 0) {
  console.error(`No scenario found: ${values.scenario}`);
  process.exit(1);
}

// ─── Run each scenario ───────────────────────────────────────────────────────
const results = [];

for (const scenario of scenarios) {
  const baselineFiles = scenario.without_kontexta.files.map((f) => ({
    path: f,
    ...countTokens(f),
  }));
  const kontextaFiles = scenario.with_kontexta.files.map((f) => ({
    path: f,
    ...countTokens(f),
  }));

  const baselineTokens = baselineFiles.reduce((s, f) => s + f.tokens, 0);
  const kontextaTokens = kontextaFiles.reduce((s, f) => s + f.tokens, 0);
  const saved = baselineTokens - kontextaTokens;
  const ratio = (baselineTokens / kontextaTokens).toFixed(1);
  const reduction = pct(saved, baselineTokens);

  results.push({
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    baseline: {
      rationale: scenario.without_kontexta.rationale,
      file_count: baselineFiles.length,
      tokens: baselineTokens,
      files: baselineFiles,
    },
    kontexta: {
      rationale: scenario.with_kontexta.rationale,
      file_count: kontextaFiles.length,
      tokens: kontextaTokens,
      files: kontextaFiles,
    },
    savings: {
      tokens_saved: saved,
      files_saved: baselineFiles.length - kontextaFiles.length,
      reduction_pct: parseFloat(reduction),
      efficiency_ratio: parseFloat(ratio),
    },
  });
}

// ─── JSON output (for website embedding) ────────────────────────────────────
if (values.json) {
  const output = {
    generated_at: new Date().toISOString(),
    project: config.project,
    methodology: config.methodology,
    tokenizer: "cl100k_base (GPT-4 / gpt-tokenizer)",
    aggregate: {
      scenarios: results.length,
      avg_reduction_pct: parseFloat(
        (results.reduce((s, r) => s + r.savings.reduction_pct, 0) / results.length).toFixed(1)
      ),
      avg_efficiency_ratio: parseFloat(
        (results.reduce((s, r) => s + r.savings.efficiency_ratio, 0) / results.length).toFixed(1)
      ),
    },
    scenarios: results,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

// ─── Human-readable output ───────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════════════╗");
console.log("║           KONTEXTA TOKEN EFFICIENCY BENCHMARK                  ║");
console.log("║           Tokenizer: cl100k_base (GPT-4 equivalent)            ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");
console.log(`  Project: ${config.project}`);
console.log(`  Methodology: ${config.methodology}\n`);
printHr();

for (const r of results) {
  console.log(`\n  📌  Scenario: ${r.name}`);
  console.log(`      ${r.description}\n`);

  console.log(`  ❌  Without Kontexta  (${r.baseline.file_count} files — ${r.baseline.rationale})`);
  printTable(
    [
      ["File", "Tokens"],
      ...r.baseline.files.map((f) => [f.path.replace(/^apps\/web\/src\//, ""), fmt(f.tokens)]),
      ["TOTAL", fmt(r.baseline.tokens)],
    ],
    [1]
  );

  console.log(`\n  ✅  With Kontexta MCP  (${r.kontexta.file_count} files — ${r.kontexta.rationale})`);
  printTable(
    [
      ["File", "Tokens"],
      ...r.kontexta.files.map((f) => [f.path.replace(/^apps\/web\/src\//, ""), fmt(f.tokens)]),
      ["TOTAL", fmt(r.kontexta.tokens)],
    ],
    [1]
  );

  console.log(`\n  🎯  Saved ${fmt(r.savings.tokens_saved)} tokens  —  ${r.savings.reduction_pct}% reduction  —  ${r.savings.efficiency_ratio}x more efficient\n`);
  printHr();
}

// ─── Aggregate summary ───────────────────────────────────────────────────────
const avgReduction = (results.reduce((s, r) => s + r.savings.reduction_pct, 0) / results.length).toFixed(1);
const avgRatio = (results.reduce((s, r) => s + r.savings.efficiency_ratio, 0) / results.length).toFixed(1);

console.log("\n  ╔══════════════════════════════════════╗");
console.log("  ║         AGGREGATE RESULTS            ║");
console.log("  ╚══════════════════════════════════════╝\n");
printTable(
  [
    ["Scenario", "Baseline", "Kontexta", "Saved", "Reduction"],
    ...results.map((r) => [
      r.name,
      fmt(r.baseline.tokens),
      fmt(r.kontexta.tokens),
      fmt(r.savings.tokens_saved),
      `${r.savings.reduction_pct}%`,
    ]),
  ],
  [1, 2, 3]
);

console.log(`\n  Average token reduction across all scenarios: ${avgReduction}%`);
console.log(`  Average efficiency ratio:                     ${avgRatio}x\n`);
console.log(`  Run with --json to get machine-readable output for website embedding.\n`);
