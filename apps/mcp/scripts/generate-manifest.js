// apps/mcp/scripts/generate-manifest.js
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const MCP_BIN = path.resolve(import.meta.dirname, "../dist/index.js");
const OUT = path.resolve(import.meta.dirname, "../../web/src/lib/mcp-tools.json");

if (!existsSync(MCP_BIN)) {
  console.error(`MCP not built. Run: pnpm --filter kontexta-mcp build`);
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });

const child = spawn("node", [MCP_BIN], {
  env: { ...process.env, KONTEXTA_DATA_DIR: process.env.KONTEXTA_DATA_DIR ?? "/tmp/kontexta-manifest" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let nextId = 1;
const pending = new Map();

const REQUEST_TIMEOUT_MS = 30_000;

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* not JSON, ignore */ }
  }
});

(async () => {
  try {
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "manifest-gen", version: "0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const res = await send("tools/list", {});
    const tools = res?.result?.tools ?? [];
    if (tools.length === 0) {
      console.error("No tools returned");
      child.kill();
      process.exit(2);
    }
    writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), tools }, null, 2));
    console.log(`Wrote ${tools.length} tools to ${OUT}`);
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error(e?.message ?? e);
    child.kill();
    process.exit(3);
  }
})();
