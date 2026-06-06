#!/usr/bin/env node
/**
 * Smoke-test every MCP tool. Spawns the built server over stdio,
 * issues JSON-RPC requests, checks results against expected shape.
 *
 * Run:
 *   node apps/mcp/test-tools.mjs
 *
 * Exits non-zero on any failure. Designed to be safe against the local
 * data dir — every artefact created during the run is also deleted.
 */

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const SERVER = join(REPO, "apps/mcp/dist/index.js");

// Use a fresh temp dataDir so we don't pollute the user's KB.
const DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-test-"));
mkdirSync(join(DATA_DIR, "knowledge"), { recursive: true });
// Seeds will be created via the create_file tool itself (the MCP server
// doesn't run a watcher — that's the web app's job — so writeFileSync'd
// files would never get indexed).
const SEED_TITLE_1 = "auth-notes";
const SEED_TITLE_2 = "deployment-checklist";
const SEED_PATH_1 = join(DATA_DIR, "knowledge", `${SEED_TITLE_1}.md`);
const SEED_PATH_2 = join(DATA_DIR, "knowledge", `${SEED_TITLE_2}.md`);

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

function rpc(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 10000);
  });
}

async function call(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(`${name} returned isError: ${r.content[0].text}`);
  // Tool responses are wrapped as {content: [{type:"text", text: "<json>"}]}
  return JSON.parse(r.content[0].text);
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  // 1. Initialize handshake.
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0" },
  });
  await rpc("notifications/initialized", undefined).catch(() => {});

  // 2. Discover tools.
  const list = await rpc("tools/list", {});
  const toolNames = list.tools.map((t) => t.name).sort();
  console.log(`\n[test] discovered ${toolNames.length} tools:`);
  console.log("       " + toolNames.join(", "));
  console.log("");

  let seedFile1, seedFile2;

  // ---- Seed via the indexed write path so files actually land in the DB ----
  await test("create_file (seed 1)", async () => {
    const r = await call("create_file", {
      title: SEED_TITLE_1,
      content: "# Authentication notes\n\nWe use OAuth and JWT tokens.\n\n## Setup\n\nInstall the auth middleware.\n\n## Rotation\n\nKeys rotate weekly.\n",
      destination: "knowledge",
    });
    seedFile1 = r;
    assert(r.path === SEED_PATH_1, `wrong path: ${r.path}`);
    assert(typeof r.est_tokens === "number", "missing est_tokens");
  });

  await test("create_file (seed 2)", async () => {
    const r = await call("create_file", {
      title: SEED_TITLE_2,
      content: "# Deployment checklist\n\n## Pre-flight\n\nRun migrations.\n\n## Post-flight\n\nVerify health.\n",
      destination: "knowledge",
    });
    seedFile2 = r;
    assert(r.path === SEED_PATH_2, `wrong path: ${r.path}`);
  });

  // ---- Read / list ----
  await test("list_files (KB scope)", async () => {
    const r = await call("list_files", { project_id: null });
    assert(r.files.length >= 2, `expected ≥2 KB files, got ${r.files.length}`);
    const got1 = r.files.find((f) => f.id === seedFile1.id);
    const got2 = r.files.find((f) => f.id === seedFile2.id);
    assert(got1, "seed file 1 not in list");
    assert(got2, "seed file 2 not in list");
    assert(typeof got1.est_tokens === "number", "missing est_tokens");
    assert(Array.isArray(got1.tags), "missing tags array");
  });

  await test("read_file", async () => {
    const r = await call("read_file", { id: seedFile1.id });
    assert(r.content.includes("OAuth"), "content missing");
    assert(typeof r.est_tokens === "number", "missing est_tokens");
  });

  await test("read_files batch", async () => {
    const r = await call("read_files", { ids: [seedFile1.id, seedFile2.id, 999999] });
    assert(r.files.length === 2, `expected 2 files, got ${r.files.length}`);
    assert(r.error_count === 1, `expected 1 error for missing id, got ${r.error_count}`);
    assert(r.errors[0].id === 999999, "wrong error id");
  });

  await test("describe_file (no content, full metadata)", async () => {
    const r = await call("describe_file", { id: seedFile1.id });
    assert(r.id === seedFile1.id, "wrong id");
    assert(typeof r.size_bytes === "number", "missing size_bytes");
    assert(typeof r.history_count === "number", "missing history_count");
    assert(Array.isArray(r.tags), "missing tags array");
    assert(Array.isArray(r.related), "missing related array");
    assert(Array.isArray(r.backlinks), "missing backlinks array");
    assert(!("content" in r), "should NOT include content (that's the whole point)");
  });

  await test("read_file_lines (range)", async () => {
    const r = await call("read_file_lines", { id: seedFile1.id, from: 1, to: 2 });
    assert(r.from === 1 && r.to === 2, `wrong range: ${r.from}-${r.to}`);
    assert(r.content.includes("Authentication notes"), "first line missing");
    assert(typeof r.total_lines === "number", "missing total_lines");
  });

  await test("read_file_lines (out-of-range clamps)", async () => {
    const r = await call("read_file_lines", { id: seedFile1.id, from: 1, to: 9999 });
    assert(r.to === r.total_lines, `to should clamp to ${r.total_lines}, got ${r.to}`);
  });

  await test("grep_in_file (literal match)", async () => {
    const r = await call("grep_in_file", { id: seedFile1.id, pattern: "OAuth" });
    assert(r.match_count >= 1, `expected ≥1 match, got ${r.match_count}`);
    assert(typeof r.matches[0].line === "number", "missing line number");
  });

  await test("grep_in_file (invalid regex errors)", async () => {
    try {
      await call("grep_in_file", { id: seedFile1.id, pattern: "[unclosed" });
      throw new Error("should have errored");
    } catch (e) {
      assert(e.message.includes("invalid regex"), `wrong error: ${e.message}`);
    }
  });

  await test("regex_search across KB", async () => {
    const r = await call("regex_search", { pattern: "OAuth|migrations", project_id: null });
    assert(r.file_hit_count >= 2, `expected ≥2 file hits, got ${r.file_hit_count}`);
    assert(r.hits[0].matches[0].line > 0, "missing line number on hit");
  });

  // ---- Search ----
  await test("search returns match_excerpt + title_highlight", async () => {
    const r = await call("search", { query: "OAuth" });
    assert(r.matches.length >= 1, "no matches for OAuth");
    const m = r.matches[0];
    assert(typeof m.match_excerpt === "string", "match_excerpt missing");
    assert(m.match_excerpt.includes("<<<"), `match_excerpt has no markers: ${m.match_excerpt}`);
    assert(typeof m.title_highlight === "string", "title_highlight missing");
  });

  await test("bundle_search", async () => {
    const r = await call("bundle_search", { query: "deployment", max_tokens: 5000 });
    assert(typeof r.bundle === "string", "bundle missing");
    assert(r.bundle.length > 0, "bundle empty");
  });

  // ---- Section ops (NEW) ----
  await test("read_file_outline", async () => {
    const r = await call("read_file_outline", { file_id: seedFile1.id });
    assert(Array.isArray(r.outline), "outline not array");
    const headings = r.outline.map((n) => n.text);
    assert(headings.includes("Authentication notes"), `missing H1 in ${headings}`);
    assert(headings.includes("Setup"), `missing Setup in ${headings}`);
    assert(headings.includes("Rotation"), `missing Rotation in ${headings}`);
  });

  await test("read_section returns just that body", async () => {
    const r = await call("read_section", { file_id: seedFile1.id, heading: "Setup" });
    assert(r.content.includes("auth middleware"), `wrong section content: ${r.content}`);
    assert(!r.content.includes("rotate weekly"), "section bled into next");
    assert(!r.content.startsWith("## Setup"), "section included its own heading");
  });

  await test("read_section: missing heading errors cleanly", async () => {
    try {
      await call("read_section", { file_id: seedFile1.id, heading: "Nonexistent" });
      throw new Error("should have errored");
    } catch (e) {
      assert(e.message.includes("Section not found"), `wrong error: ${e.message}`);
    }
  });

  await test("update_file_section preserves siblings", async () => {
    await call("update_file_section", {
      file_id: seedFile1.id,
      heading: "Setup",
      content: "Run `npm install` and configure middleware.\n",
    });
    const r = await call("read_file", { id: seedFile1.id });
    assert(r.content.includes("Run `npm install`"), "new content not written");
    assert(r.content.includes("Rotation"), "Rotation section was lost");
    assert(r.content.includes("rotate weekly"), "Rotation body was lost");
    assert(!r.content.includes("Install the auth middleware"), "old content lingered");
  });

  // ---- Folder ops (NEW) ----
  await test("list_folders (KB)", async () => {
    const r = await call("list_folders", { project_id: null });
    assert(Array.isArray(r.folders), "folders not array");
    assert(typeof r.base_path === "string", "missing base_path");
  });

  await test("create_folder + delete_folder round-trip", async () => {
    const c = await call("create_folder", { project_id: null, name: "smoke-test-folder" });
    assert(c.path.endsWith("smoke-test-folder"), `wrong path: ${c.path}`);
    const list = await call("list_folders", { project_id: null });
    assert(list.folders.includes("smoke-test-folder"), "folder not in list");
    const d = await call("delete_folder", { project_id: null, name: "smoke-test-folder" });
    assert(d.success === true, "delete failed");
  });

  await test("create_folder rejects '..'", async () => {
    try {
      await call("create_folder", { project_id: null, name: "../escape" });
      throw new Error("should have errored");
    } catch (e) {
      assert(e.message.includes("'..'") || e.message.includes("Invalid"), `wrong error: ${e.message}`);
    }
  });

  // ---- Move file (NEW) ----
  await test("move_file inside KB", async () => {
    const newPath = join(DATA_DIR, "knowledge", "auth-notes-renamed.md");
    const r = await call("move_file", { file_id: seedFile1.id, new_path: newPath });
    assert(r.path === newPath, `expected ${newPath}, got ${r.path}`);
    assert(existsSync(newPath), "file not moved on disk");
    // Move it back so subsequent tests still find it.
    await call("move_file", { file_id: seedFile1.id, new_path: SEED_PATH_1 });
  });

  await test("move_file rejects path outside base", async () => {
    try {
      await call("move_file", { file_id: seedFile1.id, new_path: "/tmp/escape.md" });
      throw new Error("should have errored");
    } catch (e) {
      assert(e.message.includes("must be inside"), `wrong error: ${e.message}`);
    }
  });

  // ---- Batch ops (NEW) ----
  let batchIds = [];
  await test("create_files batch", async () => {
    const r = await call("create_files", {
      files: [
        { title: "batch-a", content: "alpha", destination: "knowledge" },
        { title: "batch-b", content: "beta", destination: "knowledge" },
        { title: "batch-c", content: "gamma", destination: "knowledge" },
      ],
    });
    assert(r.created_count === 3, `expected 3 created, got ${r.created_count}`);
    assert(r.error_count === 0, `unexpected errors: ${JSON.stringify(r.errors)}`);
    batchIds = r.created.map((f) => f.id);
  });

  await test("delete_files batch", async () => {
    const r = await call("delete_files", { ids: batchIds });
    assert(r.deleted_count === batchIds.length, `expected ${batchIds.length} deleted, got ${r.deleted_count}`);
  });

  // ---- Tagging ----
  await test("add_tags + list_tags", async () => {
    await call("add_tags", { file_id: seedFile1.id, tags: ["smoke", "auth-test"] });
    const r = await call("list_tags");
    const names = r.map((t) => t.name);
    assert(names.includes("smoke"), `missing 'smoke' tag in ${names}`);
  });

  await test("tag_search_results bulk-applies", async () => {
    const r = await call("tag_search_results", { query: "deployment", add_tags: ["devops-test"] });
    assert(r.tagged_count >= 1, `expected ≥1 tagged, got ${r.tagged_count}`);
  });

  // ---- Path lookup (NEW) ----
  await test("read_file_by_path", async () => {
    const r = await call("read_file_by_path", { path: SEED_PATH_2 });
    assert(r.id === seedFile2.id, `wrong id: ${r.id}`);
    assert(r.content.includes("Run migrations"), "content missing");
  });

  await test("read_file_by_path: missing path errors", async () => {
    try {
      await call("read_file_by_path", { path: "/nonexistent/file.md" });
      throw new Error("should have errored");
    } catch (e) {
      assert(e.message.includes("No file indexed"), `wrong error: ${e.message}`);
    }
  });

  // ---- Stats (NEW) ----
  await test("stats KB scope", async () => {
    const r = await call("stats", { project_id: null });
    assert(r.scope === "knowledge_base", `wrong scope: ${r.scope}`);
    assert(typeof r.file_count === "number", "missing file_count");
    assert(Array.isArray(r.top_tags), "missing top_tags");
  });

  await test("stats with token total", async () => {
    const r = await call("stats", { project_id: null, include_token_total: true });
    assert(typeof r.total_est_tokens === "number", "missing total_est_tokens");
  });

  // ---- QoL (NEW) ----
  await test("suggest_tags returns shape", async () => {
    const r = await call("suggest_tags", { file_id: seedFile1.id });
    assert(Array.isArray(r.suggestions), "missing suggestions");
    assert(Array.isArray(r.existing_tags), "missing existing_tags");
  });

  await test("diff_against_disk: in_sync", async () => {
    const r = await call("diff_against_disk", { file_id: seedFile1.id });
    assert(r.status === "in_sync", `expected in_sync, got ${r.status}`);
  });

  await test("diff_against_disk: detects divergence", async () => {
    // Mutate disk WITHOUT going through updateFile, so the FTS index lags.
    writeFileSync(SEED_PATH_2, "# Deployment checklist\n\n## Pre-flight\n\nNEW DIVERGENT LINE\n");
    // No watcher debounce wait — we want to catch the divergence window.
    const r = await call("diff_against_disk", { file_id: seedFile2.id });
    if (r.status === "in_sync") {
      // Watcher beat us; that's fine, just note it.
      console.log("      (watcher reingested before check; divergence not observable)");
      return;
    }
    assert(r.status === "diverged", `expected diverged, got ${r.status}`);
    assert(typeof r.first_diff_line === "number", "missing first_diff_line");
  });

  await test("refresh_index (KB) picks up out-of-band file", async () => {
    // Write a file directly to disk (bypassing create_file). Without
    // refresh_index it would never be indexed in MCP-only mode.
    const sneakyPath = join(DATA_DIR, "knowledge", "sneaked-in.md");
    writeFileSync(sneakyPath, "# Sneaked\n\nThis file was added behind Kontexta's back.\n");
    const before = await call("read_file_by_path", { path: sneakyPath }).catch((e) => e.message);
    assert(typeof before === "string" && before.includes("No file indexed"), "file should not be indexed yet");
    const r = await call("refresh_index", { project_id: null });
    assert(r.scope === "knowledge_base", `wrong scope: ${r.scope}`);
    assert(r.newly_indexed >= 1, `expected ≥1 newly indexed, got ${r.newly_indexed}`);
    const after = await call("read_file_by_path", { path: sneakyPath });
    assert(after.content.includes("Sneaked"), "file content missing after refresh");
  });

  await test("refresh_index (KB) picks up out-of-band edit", async () => {
    // Mutate a known indexed file directly.
    const sneakyPath = join(DATA_DIR, "knowledge", "sneaked-in.md");
    writeFileSync(sneakyPath, "# Sneaked v2\n\nEdited behind the index's back.\n");
    const r = await call("refresh_index", { project_id: null });
    assert(r.refreshed >= 1, `expected ≥1 refreshed, got ${r.refreshed}`);
    const after = await call("read_file_by_path", { path: sneakyPath });
    assert(after.content.includes("v2"), `expected v2 content, got: ${after.content}`);
  });

  await test("refresh_index (KB) prunes vanished files", async () => {
    const sneakyPath = join(DATA_DIR, "knowledge", "sneaked-in.md");
    rmSync(sneakyPath, { force: true });
    const r = await call("refresh_index", { project_id: null });
    assert(r.pruned >= 1, `expected ≥1 pruned, got ${r.pruned}`);
    const after = await call("read_file_by_path", { path: sneakyPath }).catch((e) => e.message);
    assert(typeof after === "string" && after.includes("No file indexed"), "row should be pruned");
  });

  await test("journal_append creates + appends", async () => {
    const r1 = await call("journal_append", { text: "First thought of the day." });
    assert(typeof r1.file_id === "number", "missing file_id");
    const r2 = await call("journal_append", { text: "Second thought, same day." });
    assert(r2.file_id === r1.file_id, `expected same file, got ${r2.file_id} vs ${r1.file_id}`);
    const file = await call("read_file", { id: r1.file_id });
    assert(file.content.includes("First thought"), "first entry missing");
    assert(file.content.includes("Second thought"), "second entry missing");
  });

  // ---- Project ops ----
  let projectId;
  await test("register_project", async () => {
    const r = await call("register_project", {
      name: "smoke-project",
      path: DATA_DIR, // any existing dir works
    });
    assert(r.project, "no project returned");
    projectId = r.project.id;
  });

  await test("list_projects", async () => {
    const r = await call("list_projects");
    assert(Array.isArray(r), "expected array");
    assert(r.some((p) => p.id === projectId), "registered project missing");
  });

  await test("project_map", async () => {
    const r = await call("project_map", { project_id: projectId });
    assert(typeof r.outline === "string", "missing outline");
    assert(typeof r.est_tokens === "number", "missing est_tokens");
  });

  // ---- whats_new / find_related / get_history ----
  await test("whats_new", async () => {
    const r = await call("whats_new", { since: "1d" });
    assert(Array.isArray(r.files), "missing files");
  });

  await test("find_related", async () => {
    const r = await call("find_related", { file_id: seedFile1.id });
    assert(Array.isArray(r.related), "missing related");
  });

  await test("get_history", async () => {
    const r = await call("get_history", { file_id: seedFile1.id });
    assert(Array.isArray(r.history), "missing history");
  });

  // ---- Hands integration ----
  await test("hands: register, list, invoke, confirm", async () => {
    const handsRoot = mkdtempSync(join(tmpdir(), "kontexta-hands-"));
    writeFileSync(join(handsRoot, "kontexta.json"), JSON.stringify({
      version: "1",
      tools: {
        "say-hi": {
          description: "echoes hello-from-hands",
          command: ["echo", "hello-from-hands"],
        },
        "needs-approval": {
          description: "echoes only after confirmation",
          command: ["echo", "approved"],
          confirm: true,
        },
      },
    }));

    const reg = await call("register_project", { name: "handsproj", path: handsRoot });
    assert(reg.hands?.tools_registered === 2, `expected 2 hands registered, got ${JSON.stringify(reg.hands)}`);

    const listResp = await rpc("tools/call", { name: "list_hands", arguments: {} });
    const listText = listResp.content[0].text;
    assert(listText.includes("handsproj__say-hi"), "say-hi not found in list_hands output");

    // Direct invocation (no confirm)
    const sayHiResp = await rpc("tools/call", { name: "handsproj__say-hi", arguments: {} });
    const sayHiText = sayHiResp.content[0].text;
    assert(sayHiText.includes("hello-from-hands"), `say-hi output unexpected:\n${sayHiText}`);
    assert(sayHiText.includes("Success") || sayHiText.includes("exit 0"), `say-hi missing success marker:\n${sayHiText}`);

    // Confirm flow
    const pendingResp = await rpc("tools/call", { name: "handsproj__needs-approval", arguments: {} });
    const pendingText = pendingResp.content[0].text;
    const tokenMatch = pendingText.match(/token:\s*"([a-f0-9]{64})"/);
    assert(tokenMatch, `no token in pending response:\n${pendingText}`);
    const confirmedResp = await rpc("tools/call", { name: "confirm_hand", arguments: { token: tokenMatch[1] } });
    const confirmedText = confirmedResp.content[0].text;
    assert(confirmedText.includes("approved"), `confirm_hand result missing 'approved':\n${confirmedText}`);

    // describe_hands_schema returns substantive doc (as raw text, not JSON)
    const docResp = await rpc("tools/call", { name: "describe_hands_schema", arguments: {} });
    const docText = docResp.content[0].text;
    assert(docText.includes("Authoring Reference"), "describe_hands_schema missing expected content");

    rmSync(handsRoot, { recursive: true, force: true });
  });

  // ---- onboard_agent ----
  await test("register_project recommends onboarding, onboard_agent updates+skips", async () => {
    const root = mkdtempSync(join(tmpdir(), "kontexta-rules-"));
    writeFileSync(join(root, "CLAUDE.md"), "# Existing\n\nUser content.\n");

    const reg = await call("register_project", { name: "rulesproj", path: root });
    assert(reg.recommendation, "missing recommendation");
    assert(reg.recommendation.mode === "update", `expected update mode, got ${reg.recommendation.mode}`);
    assert(reg.recommendation.target_files.includes("CLAUDE.md"), "CLAUDE.md missing from target_files");
    const projId = reg.project.id;

    const r1 = await call("onboard_agent", { project_id: projId, files: ["CLAUDE.md"], confirm: true });
    assert(r1.written?.[0]?.action === "updated", `expected updated, got ${JSON.stringify(r1)}`);
    assert(r1.written[0].path === "CLAUDE.md", "wrong path");

    const r2 = await call("onboard_agent", { project_id: projId, files: ["CLAUDE.md"], confirm: true });
    assert(r2.written?.[0]?.action === "skipped", `expected skipped on second run, got ${JSON.stringify(r2)}`);

    rmSync(root, { recursive: true, force: true });
  });

  await test("onboard_agent create mode scaffolds AGENTS.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "kontexta-rules-create-"));

    const reg = await call("register_project", { name: "rulesproj-create", path: root });
    assert(reg.recommendation.mode === "create", `expected create mode, got ${reg.recommendation.mode}`);
    const projId = reg.project.id;

    const r = await call("onboard_agent", { project_id: projId, target_agent: "codex", confirm: true });
    assert(r.written?.[0]?.action === "created", `expected created, got ${JSON.stringify(r)}`);
    assert(r.written[0].path === "AGENTS.md", `expected AGENTS.md, got ${r.written[0].path}`);
    assert(existsSync(join(root, "AGENTS.md")), "AGENTS.md not created on disk");

    rmSync(root, { recursive: true, force: true });
  });

  await test("onboard_agent create mode scaffolds ANTIGRAVITY.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "kontexta-rules-antigravity-"));

    const reg = await call("register_project", { name: "rulesproj-antigravity", path: root });
    const projId = reg.project.id;

    const r = await call("onboard_agent", { project_id: projId, target_agent: "antigravity", confirm: true });
    assert(r.written?.[0]?.action === "created", `expected created, got ${JSON.stringify(r)}`);
    assert(r.written[0].path === "ANTIGRAVITY.md", `expected ANTIGRAVITY.md, got ${r.written[0].path}`);
    assert(existsSync(join(root, "ANTIGRAVITY.md")), "ANTIGRAVITY.md not created on disk");

    rmSync(root, { recursive: true, force: true });
  });

  // ---- transfer_agent_context ----
  await test("transfer_agent_context copies originals, idempotent, never deletes", async () => {
    const root = mkdtempSync(join(tmpdir(), "kontexta-transfer-"));
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    const claudeContent = "# Project rules\n\nUse TypeScript strict mode.\n";
    const cursorContent = "# Style\n\nNo any.\n";
    writeFileSync(join(root, "CLAUDE.md"), claudeContent);
    writeFileSync(join(root, ".cursor", "rules", "style.mdc"), cursorContent);

    const reg = await call("register_project", { name: "transferproj", path: root });
    const projId = reg.project.id;

    // Snapshot originals to prove we never touch them.
    const claudeStatBefore = statSync(join(root, "CLAUDE.md"));
    const cursorStatBefore = statSync(join(root, ".cursor", "rules", "style.mdc"));

    // 1. Refuses without confirm:true (call() throws on isError responses)
    let consentRefused = false;
    try {
      await call("transfer_agent_context", { project_id: projId, confirm: false });
    } catch (e) {
      consentRefused = String(e.message).includes("User consent required");
    }
    assert(consentRefused, "expected User consent required error when confirm is false");

    // 2. Transfers all detected files
    const r1 = await call("transfer_agent_context", { project_id: projId, confirm: true });
    assert(Array.isArray(r1.transferred) && r1.transferred.length === 2, `expected 2 transferred, got ${JSON.stringify(r1)}`);
    assert(r1.skipped.length === 0, `expected 0 skipped, got ${JSON.stringify(r1.skipped)}`);
    const paths = r1.transferred.map((t) => t.source_path).sort();
    assert(paths[0] === ".cursor/rules/style.mdc" && paths[1] === "CLAUDE.md", `unexpected paths: ${paths}`);

    // Confirm KB files exist and content matches
    for (const t of r1.transferred) {
      assert(existsSync(t.kb_path), `kb_path missing: ${t.kb_path}`);
      const expected = t.source_path === "CLAUDE.md" ? claudeContent : cursorContent;
      assert(readFileSync(t.kb_path, "utf8") === expected, `content mismatch in ${t.kb_path}`);
    }

    // 3. Originals UNCHANGED — same mtime, size, content
    const claudeStatAfter = statSync(join(root, "CLAUDE.md"));
    const cursorStatAfter = statSync(join(root, ".cursor", "rules", "style.mdc"));
    assert(claudeStatAfter.mtimeMs === claudeStatBefore.mtimeMs, "CLAUDE.md mtime changed — originals must NOT be modified");
    assert(cursorStatAfter.mtimeMs === cursorStatBefore.mtimeMs, "style.mdc mtime changed");
    assert(readFileSync(join(root, "CLAUDE.md"), "utf8") === claudeContent, "CLAUDE.md content changed");
    assert(readFileSync(join(root, ".cursor", "rules", "style.mdc"), "utf8") === cursorContent, "style.mdc content changed");

    // 4. Idempotent — re-run skips both as already_transferred_same_content
    const r2 = await call("transfer_agent_context", { project_id: projId, confirm: true });
    assert(r2.transferred.length === 0, `expected 0 on re-run, got ${r2.transferred.length}`);
    assert(r2.skipped.length === 2, `expected 2 skipped on re-run, got ${r2.skipped.length}`);
    assert(r2.skipped.every((s) => s.reason === "already_transferred_same_content"), `expected idempotent skip reason, got ${JSON.stringify(r2.skipped)}`);

    // 5. Safety: path-traversal attempt rejected
    const r3 = await call("transfer_agent_context", { project_id: projId, confirm: true, files: ["../../../etc/passwd"] });
    assert(r3.skipped[0].reason === "outside_project", `expected outside_project, got ${JSON.stringify(r3)}`);
    assert(r3.transferred.length === 0, "must not transfer escape path");

    // 6. Symlinks rejected
    writeFileSync(join(root, "REAL.md"), "real");
    symlinkSync(join(root, "REAL.md"), join(root, "LINK.md"));
    const r4 = await call("transfer_agent_context", { project_id: projId, confirm: true, files: ["LINK.md"] });
    assert(r4.skipped[0].reason === "symlink", `expected symlink reject, got ${JSON.stringify(r4)}`);

    rmSync(root, { recursive: true, force: true });
  });

  // ---- Cleanup ----
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(DATA_DIR, { recursive: true, force: true });

  // ---- Report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[test] ${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log(`\nFailed:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("fatal:", e);
  child.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
