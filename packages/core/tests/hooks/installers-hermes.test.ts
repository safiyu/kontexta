import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { INSTALLERS } from "../../src/hooks/installers/index.js";

describe("hermes installer (shell hooks in config.yaml)", () => {
  let home: string; let dataDir: string;
  const ctx = () => ({ home, dataDir });
  const cfgPath = () => join(home, ".hermes", "config.yaml");
  const seed = (text: string) => { mkdirSync(dirname(cfgPath()), { recursive: true }); writeFileSync(cfgPath(), text); };
  const load = () => parse(readFileSync(cfgPath(), "utf8"));
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-home-")); dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });

  it("creates the hooks block with one owned entry per event, matcher only on post_tool_call", () => {
    const r = INSTALLERS.hermes.install(ctx());
    expect(r.changed).toBe(true);
    expect(r.path).toBe(cfgPath());
    const hooks = load().hooks;
    expect(Object.keys(hooks).sort()).toEqual(["post_llm_call", "post_tool_call", "pre_llm_call", "subagent_stop"]);
    for (const ev of Object.keys(hooks)) {
      expect(hooks[ev]).toHaveLength(1);
      expect(hooks[ev][0].command).toContain("--agent hermes");
      expect(hooks[ev][0].command).toContain(join(dataDir, "hooks", "emit.mjs"));
      expect(hooks[ev][0].timeout).toBe(5);
    }
    expect(hooks.post_tool_call[0].matcher).toBe("terminal");
    expect(hooks.pre_llm_call[0].matcher).toBeUndefined();
    expect(INSTALLERS.hermes.status(ctx()).installed).toBe(true);
    const commandLines = readFileSync(cfgPath(), "utf8").split("\n").filter((l) => l.includes("command:"));
    for (const l of commandLines) expect(l).toContain("--data-dir");
  });

  it("keeps comments, unrelated keys and the user's own hooks; reinstall is a no-op", () => {
    seed(`# my hermes config\nmodel: sonnet  # default model\nhooks:\n  post_tool_call:\n    - matcher: "write_file"\n      command: "~/.hermes/agent-hooks/fmt.sh"\n  outbound:\n    - url: https://ci.example.com/x\n      events: [on_session_end]\n`);
    INSTALLERS.hermes.install(ctx());
    const text = readFileSync(cfgPath(), "utf8");
    expect(text).toContain("# my hermes config");
    expect(text).toContain("# default model");
    const cfg = load();
    expect(cfg.model).toBe("sonnet");
    expect(cfg.hooks.outbound).toEqual([{ url: "https://ci.example.com/x", events: ["on_session_end"] }]);
    expect(cfg.hooks.post_tool_call).toHaveLength(2);
    expect(cfg.hooks.post_tool_call[0].command).toBe("~/.hermes/agent-hooks/fmt.sh");
    expect(INSTALLERS.hermes.install(ctx()).changed).toBe(false);
  });

  it("uninstall removes only our entries and keeps everything else", () => {
    seed(`# keep me\nhooks:\n  post_tool_call:\n    - command: "~/.hermes/agent-hooks/fmt.sh"\n`);
    INSTALLERS.hermes.install(ctx());
    expect(INSTALLERS.hermes.uninstall(ctx()).changed).toBe(true);
    const text = readFileSync(cfgPath(), "utf8");
    expect(text).toContain("# keep me");
    expect(text).not.toContain("emit.mjs");
    expect(load().hooks).toEqual({ post_tool_call: [{ command: "~/.hermes/agent-hooks/fmt.sh" }] });
    expect(INSTALLERS.hermes.status(ctx()).installed).toBe(false);
  });

  it("uninstall drops an emptied hooks block entirely", () => {
    INSTALLERS.hermes.install(ctx());
    INSTALLERS.hermes.uninstall(ctx());
    expect(load()?.hooks).toBeUndefined();
  });

  it("refuses invalid YAML or a non-mapping hooks key, and dry-run writes nothing", () => {
    seed("hooks: [unclosed\n");
    expect(() => INSTALLERS.hermes.install(ctx())).toThrow(/not valid YAML/);
    seed("hooks: nope\n");
    expect(() => INSTALLERS.hermes.install(ctx())).toThrow(/hooks/);
    expect(readFileSync(cfgPath(), "utf8")).toBe("hooks: nope\n");
    rmSync(cfgPath());
    INSTALLERS.hermes.install({ ...ctx(), dryRun: true });
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("does not pre-approve the hooks: Hermes asks for consent itself", () => {
    const r = INSTALLERS.hermes.install(ctx());
    expect(existsSync(join(home, ".hermes", "shell-hooks-allowlist.json"))).toBe(false);
    expect(r.notes.join(" ")).toMatch(/approve/i);
  });
});
