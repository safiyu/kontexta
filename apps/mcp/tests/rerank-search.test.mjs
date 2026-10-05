#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const MCP_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER = join(MCP_DIR, "dist/index.js");

const DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-rerank-test-"));
mkdirSync(join(DATA_DIR, "knowledge"), { recursive: true });

// Write kontexta.json into DATA_DIR
writeFileSync(
  join(DATA_DIR, "kontexta.json"),
  JSON.stringify({
    system1: { device: "cpu" },
    search: {
      rerank: { enabled: true, candidate_limit: 10, dictionary_boost: 0.08 },
      verdicts: { intent_routing: true, sufficiency_check: true, relevance_floor: 0.15 },
    },
  })
);

console.log(`[test] dataDir = ${DATA_DIR}`);

const child = spawn("node", [SERVER], {
  env: { ...process.env, KONTEXTA_DATA_DIR: DATA_DIR },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function call(toolName, args = {}) {
  const res = await rpc("tools/call", { name: toolName, arguments: args });
  if (res.isError) {
    const msg = res.content?.[0]?.text ?? JSON.stringify(res);
    throw new Error(`tool error: ${msg}`);
  }
  const text = res.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function run() {
  try {
    // 1. Initialize MCP handshake
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });

    // 2. Seed files for search
    await call("files_create", {
      files: [
        {
          title: "auth-spec",
          content: "# Authentication Specification\n\nOfficial protocol for tokens and oauth.",
          destination: "knowledge",
          folder: "knowledge/dictionary",
          kind: "dictionary",
        },
        {
          title: "oauth-debug-incident",
          content: "# OAuth Debug Incident\n\nResolved token expiry issue in staging environment.",
          destination: "knowledge",
          folder: "knowledge/notes",
          kind: "note",
        },
      ],
    });

    console.log("  ✓ Seed files created");

    // 3. Test files_search with rerank
    const searchRes = await call("files_search", {
      query: "oauth token",
      rerank: true,
    });
    assert(searchRes.matches && searchRes.matches.length >= 1, "Expected search matches");
    console.log(`  ✓ files_search with rerank returned ${searchRes.matches.length} matches`);

    // 4. Test files_search with include_bodies and check_sufficiency
    const bundleRes = await call("files_search", {
      query: "oauth token",
      include_bodies: true,
      check_sufficiency: true,
    });
    assert(bundleRes.bundle, "Expected bundle output");
    assert(bundleRes.meta, "Expected meta in bundle result");
    assert(bundleRes.meta.included.length >= 1, "Expected included items");
    assert(bundleRes.meta.sufficiency !== undefined, "Expected sufficiency verdict in meta");
    console.log(`  ✓ files_search with include_bodies and check_sufficiency evaluated (satisfied: ${bundleRes.meta.sufficiency.satisfied})`);

    // 5. Test admin_overview reports system1 status
    const overviewRes = await call("admin_overview", {
      mode: "stats",
      project_id: null,
    });
    assert(overviewRes.system1, "Expected system1 in admin_overview");
    assert.strictEqual(overviewRes.system1.ready, true, "Expected system1.ready === true");
    assert(typeof overviewRes.system1.device === "string", "Expected system1.device string");
    assert(Array.isArray(overviewRes.system1.loaded_models), "Expected loaded_models array");
    console.log(`  ✓ admin_overview reported system1 status (device: ${overviewRes.system1.device})`);

    console.log("\n[test] All rerank search tests passed successfully!");
  } finally {
    child.kill();
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  child.kill();
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
