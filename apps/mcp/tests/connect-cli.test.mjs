import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { KXTA_TOOLS } from "kxta-core";

const CLI = resolve(import.meta.dirname, "../dist/connect-cli.js");
const run = (args, env) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const scratch = () => ({ home: mkdtempSync(join(tmpdir(), "kx-home-")), data: mkdtempSync(join(tmpdir(), "kx-data-")) });

test("connect-cli: status → install (with approval) → status → approval back → uninstall", () => {
  const { home, data } = scratch();
  mkdirSync(join(home, ".gemini"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data, KONTEXTA_INSTALL_HINT: "npm" };
  try {
    let r = run(["status", "--json"], env);
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse(r.out);
    assert.ok(rows.find((x) => x.id === "gemini").mcp_supported);
    assert.equal(rows.find((x) => x.id === "aider").mcp_supported, false);
    assert.ok(rows.find((x) => x.id === "codex").mcp_supported);

    r = run(["install", "--agent", "gemini", "--approval", "all", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /gemini: connected \(approval: all\)/);
    const cfg = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.kxta, { command: "npx", args: ["-y", "kontexta", "mcp"], env: { KONTEXTA_DATA_DIR: data } });
    assert.deepEqual(cfg.permissions.allow, ["mcp(kxta/*)"]);

    r = run(["status", "--home", home], env);
    assert.match(r.out, /gemini\s+connected, approval: all/);

    r = run(["approval", "gemini", "prompt", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).permissions, undefined);

    r = run(["uninstall", "--agent", "gemini", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers, undefined);

    r = run(["install", "--agent", "aider", "--home", home], env);
    assert.equal(r.code, 1);
    assert.match(r.out + r.err, /not supported yet/);
    assert.equal(run(["bogus"], env).code, 2);
    assert.equal(run(["install", "--agent", "gemini", "--approval", "yolo", "--home", home], env).code, 2);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test("connect-cli: docker one-liner mode never opens the database and needs the host dir", () => {
  const { home, data } = scratch();
  mkdirSync(join(home, ".cursor"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data };
  try {
    let r = run(["install", "--agent", "cursor", "--home", home, "--install-mode", "docker", "--no-db"], env);
    assert.equal(r.code, 1);
    assert.match(r.out + r.err, /host data/i);
    r = run(["install", "--agent", "cursor", "--home", home, "--install-mode", "docker", "--host-data-dir", "/home/me/kx", "--no-db"], env);
    assert.equal(r.code, 0, r.err);
    const args = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.kxta.args;
    assert.ok(args.includes("/home/me/kx:/app/data"));
    assert.ok(!existsSync(join(data, "kontexta.db")), "docker one-liner must not create a database");
    assert.equal(run(["status", "--no-db"], env).code, 2);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test("connect-cli: hermes always gets an explicit data dir because Hermes strips the environment", () => {
  const { home, data } = scratch();
  mkdirSync(join(home, ".hermes"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data, KONTEXTA_INSTALL_HINT: "npm" };
  try {
    const r = run(["install", "--agent", "hermes", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(home, ".hermes", "config.yaml"), "utf8"), /KONTEXTA_DATA_DIR/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test("core's generated tool list matches the live tool manifest (regenerate with apps/mcp/scripts/generate-manifest.js)", () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../web/src/lib/mcp-tools.json"), "utf8"));
  assert.deepEqual(KXTA_TOOLS.map((t) => t.name).sort(), manifest.tools.map((t) => t.name).sort());
});

test("connect-cli is inert when imported (only running it as a script executes it)", () => {
  const url = new URL(CLI, "file://").href.startsWith("file:") ? `file://${CLI}` : CLI;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)}); console.log("imported")`], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported/);
  assert.doesNotMatch(r.stderr, /kontexta connect/);
});
