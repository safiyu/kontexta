import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI = resolve(import.meta.dirname, "../dist/hooks-cli.js");

function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("hooks-cli: status → enable installs → disable keeps config → uninstall removes", () => {
  const home = mkdtempSync(join(tmpdir(), "kx-home-"));
  const data = mkdtempSync(join(tmpdir(), "kx-data-"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data };
  try {
    let r = run(["status", "--json"], env);
    assert.equal(r.code, 0, r.err);
    let rows = JSON.parse(r.out);
    assert.equal(rows.length, 15);
    assert.ok(rows.every((x) => x.enabled === false));

    r = run(["enable", "gemini", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /gemini: installed/);
    const cfg = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    assert.ok(cfg.hooks.BeforeAgent[0].hooks[0].command.includes(join(data, "hooks", "emit.mjs")));
    assert.ok(existsSync(join(data, "hooks", "emit.mjs")));

    rows = JSON.parse(run(["status", "--json", "--home", home], env).out);
    const g = rows.find((x) => x.id === "gemini");
    assert.equal(g.enabled, true); assert.equal(g.hooks_installed, true); assert.equal(g.config_present, true);

    r = run(["disable", "gemini"], env);
    assert.equal(r.code, 0);
    assert.ok(existsSync(join(home, ".gemini", "settings.json")));

    r = run(["uninstall", "--agent", "gemini", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")), {});

    r = run(["install", "--agent", "aider", "--home", home], env);
    assert.equal(r.code, 1);
    assert.match(r.out + r.err, /does not support hooks/);

    r = run(["bogus"], env);
    assert.equal(r.code, 2);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test("hooks-cli: reconcile installs only enabled agents; stage writes emitter + sidecar", () => {
  const home = mkdtempSync(join(tmpdir(), "kx-home-"));
  const data = mkdtempSync(join(tmpdir(), "kx-data-"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data };
  try {
    run(["enable", "codex", "--no-install"], env);
    let r = run(["reconcile", "--json", "--home", home], env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).map((o) => o.agent), ["codex"]);
    assert.ok(existsSync(join(home, ".codex", "hooks.json")));
    assert.ok(!existsSync(join(home, ".claude", "settings.json")));
    assert.deepEqual(JSON.parse(run(["reconcile", "--json", "--home", home], env).out), []);

    rmSync(join(data, "hooks"), { recursive: true, force: true });
    r = run(["stage"], env);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(data, "hooks", "emit.mjs")));
    assert.ok(existsSync(join(data, "hooks", "projects.json")));
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test("hooks-cli: --no-db --host-data-dir writes host paths and never creates a database", () => {
  const home = mkdtempSync(join(tmpdir(), "kx-home-"));
  const data = mkdtempSync(join(tmpdir(), "kx-data-"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data };
  try {
    const r = run(["install", "--agent", "cursor", "--home", home, "--host-data-dir", "/host/kx", "--no-db"], env);
    assert.equal(r.code, 0, r.err);
    const cfg = readFileSync(join(home, ".cursor", "hooks.json"), "utf8");
    assert.ok(cfg.includes("/host/kx/hooks/emit.mjs"));
    assert.ok(existsSync(join(data, "hooks", "emit.mjs")));
    assert.ok(!existsSync(join(data, "kontexta.db")));
    assert.equal(run(["status", "--no-db"], env).code, 2);
    assert.equal(run(["install", "--all-enabled", "--no-db"], env).code, 2);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});
