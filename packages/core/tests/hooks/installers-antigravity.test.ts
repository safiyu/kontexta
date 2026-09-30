import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { INSTALLERS } from "../../src/hooks/installers/index.js";
import { MalformedConfigError } from "../../src/hooks/installers/json-config.js";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("antigravity installer (named-entry hooks.json)", () => {
  let home: string; let dataDir: string;
  const ctx = () => ({ home, dataDir });
  const cfgPath = () => join(home, ".gemini", "config", "hooks.json");
  const seed = (v: unknown) => { mkdirSync(dirname(cfgPath()), { recursive: true }); writeFileSync(cfgPath(), JSON.stringify(v)); };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-home-")); dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });

  it("writes one named entry with a PostToolUse group for run_command and ask_question", () => {
    const r = INSTALLERS.antigravity.install(ctx());
    expect(r.changed).toBe(true);
    expect(r.path).toBe(cfgPath());
    const entry = read(cfgPath())["kontexta-journal"];
    expect(Object.keys(entry)).toEqual(["PostToolUse"]);
    expect(entry.PostToolUse).toHaveLength(1);
    expect(entry.PostToolUse[0].matcher).toBe("run_command|ask_question");
    const h = entry.PostToolUse[0].hooks[0];
    expect(h.type).toBe("command");
    expect(h.timeout).toBe(5);
    expect(h.command).toContain("--agent antigravity");
    expect(h.command).toContain(join(dataDir, "hooks", "emit.mjs"));
    expect(INSTALLERS.antigravity.status(ctx()).installed).toBe(true);
  });

  it("leaves the user's other hook entries untouched and is idempotent", () => {
    const mine = { "my-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } };
    seed(mine);
    INSTALLERS.antigravity.install(ctx());
    const second = INSTALLERS.antigravity.install(ctx());
    expect(second.changed).toBe(false);
    expect(read(cfgPath())["my-linter"]).toEqual(mine["my-linter"]);
  });

  it("uninstall removes only our entry", () => {
    seed({ "my-linter": { Stop: [{ command: "./done.sh" }] } });
    INSTALLERS.antigravity.install(ctx());
    const r = INSTALLERS.antigravity.uninstall(ctx());
    expect(r.changed).toBe(true);
    const cfg = read(cfgPath());
    expect(Object.keys(cfg)).toEqual(["my-linter"]);
    expect(readFileSync(cfgPath(), "utf8")).not.toContain("emit.mjs");
    expect(INSTALLERS.antigravity.status(ctx()).installed).toBe(false);
  });

  it("uninstall on a machine that never installed creates nothing", () => {
    const r = INSTALLERS.antigravity.uninstall(ctx());
    expect(r.changed).toBe(false);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("keeps a user's enabled:false across reinstall", () => {
    INSTALLERS.antigravity.install(ctx());
    const cfg = read(cfgPath());
    cfg["kontexta-journal"].enabled = false;
    writeFileSync(cfgPath(), JSON.stringify(cfg));
    INSTALLERS.antigravity.install(ctx());
    expect(read(cfgPath())["kontexta-journal"].enabled).toBe(false);
  });

  it("refuses to overwrite a malformed file and dry-run writes nothing", () => {
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(cfgPath(), "{ not json");
    expect(() => INSTALLERS.antigravity.install(ctx())).toThrow(MalformedConfigError);
    rmSync(cfgPath());
    INSTALLERS.antigravity.install({ ...ctx(), dryRun: true });
    expect(existsSync(cfgPath())).toBe(false);
  });
});
