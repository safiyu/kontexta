import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIST = resolve(import.meta.dirname, "../dist");
const SERVER = join(DIST, "index.js");
const CLI = join(DIST, "hooks-cli.js");

function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, KONTEXTA_DISTILL_ENGINE: "off", ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; let nextId = 1; const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 15000);
  });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hooks-test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args = {}) => rpc("tools/call", { name, arguments: args }),
    stop: () => child.kill("SIGTERM"),
  };
}

const json = (r) => JSON.parse(r.content[0].text);

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kx-oh-home-"));
  const data = mkdtempSync(join(tmpdir(), "kx-oh-data-"));
  const proj = mkdtempSync(join(tmpdir(), "kx-oh-proj-"));
  writeFileSync(join(proj, "README.md"), "# demo\n");
  const cleanup = () => { for (const d of [home, data, proj]) rmSync(d, { recursive: true, force: true }); };
  return { home, data, proj, env: { HOME: home, KONTEXTA_DATA_DIR: data, KONTEXTA_INSTALL_HINT: "npm" }, cleanup };
}

test("no enabled agents → no hooks block anywhere", async () => {
  const f = fixture(); const s = startServer(f.env);
  try {
    await s.init();
    const reg = await s.call("projects.register", { name: "demo", path: f.proj });
    assert.equal(reg.isError, undefined);
    assert.equal("hooks" in json(reg), false);
    const ctx = await s.call("admin.refresh_session_context");
    assert.ok(!ctx.content[0].text.includes("🪝"));
  } finally { s.stop(); f.cleanup(); }
});

test("enabled agent → register carries alerts + PROMPT; onboard hooks:true installs; nudge disappears", async () => {
  const f = fixture();
  assert.equal(cli(["enable", "claude-code", "--no-install"], f.env).status, 0);
  const s = startServer(f.env);
  try {
    await s.init();
    const reg = await s.call("projects.register", { name: "demo", path: f.proj });
    const body = json(reg);
    assert.equal(body.hooks.install_mode, "npm");
    assert.deepEqual(body.hooks.alerts.map((a) => a.agent), ["claude-code"]);
    assert.ok(reg.content.some((c) => c.text.includes("PROMPT:") && c.text.includes("Claude Code")));
    const before = await s.call("admin.refresh_session_context");
    assert.ok(before.content[0].text.includes("🪝") && before.content[0].text.includes("Claude Code"));

    const done = await s.call("admin.onboard_agent", { project_id: body.project.id, confirm: true, target_agent: "claude-code", hooks: true });
    assert.equal(done.isError, undefined, done.content[0].text);
    const out = json(done);
    assert.equal(out.hooks_install.outcome.ok, true);
    assert.equal("hooks" in out, false);
    assert.ok(existsSync(join(f.home, ".claude", "settings.json")));
    assert.ok(existsSync(join(f.proj, "CLAUDE.md")));

    const after = await s.call("admin.refresh_session_context");
    assert.ok(!after.content[0].text.includes("🪝"));
  } finally { s.stop(); f.cleanup(); }
});

test("docker mode → onboard hooks:true returns the host command and writes nothing", async () => {
  const f = fixture(); f.env.KONTEXTA_INSTALL_HINT = "docker";
  cli(["enable", "gemini", "--no-install"], f.env);
  const s = startServer(f.env);
  try {
    await s.init();
    const reg = json(await s.call("projects.register", { name: "demo", path: f.proj }));
    assert.match(reg.hooks.alerts[0].docker_command, /--agent gemini/);
    const done = json(await s.call("admin.onboard_agent", { project_id: reg.project.id, confirm: true, target_agent: "gemini", hooks: true }));
    assert.match(done.hooks_install.docker_command, /--no-db/);
    assert.equal(done.hooks_install.outcome, undefined);
    assert.ok(!existsSync(join(f.home, ".gemini")));
  } finally { s.stop(); f.cleanup(); }
});

test("hooks:true without target_agent errors before writing anything", async () => {
  const f = fixture(); const s = startServer(f.env);
  try {
    await s.init();
    const reg = json(await s.call("projects.register", { name: "demo", path: f.proj }));
    const r = await s.call("admin.onboard_agent", { project_id: reg.project.id, confirm: true, hooks: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /target_agent is required/);
    assert.ok(!existsSync(join(f.proj, "CLAUDE.md")));
  } finally { s.stop(); f.cleanup(); }
});

test("hooks:true for an agent with no hook API returns a note instead of failing", async () => {
  const f = fixture(); const s = startServer(f.env);
  try {
    await s.init();
    const reg = json(await s.call("projects.register", { name: "demo", path: f.proj }));
    const r = await s.call("admin.onboard_agent", { project_id: reg.project.id, confirm: true, target_agent: "aider", hooks: true });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.match(json(r).hooks_install.note, /MCP capture only/);
    assert.equal(json(r).hooks_install.enabled, true);
    assert.ok(existsSync(join(f.proj, ".aider", "kontexta.md")));
  } finally { s.stop(); f.cleanup(); }
});
