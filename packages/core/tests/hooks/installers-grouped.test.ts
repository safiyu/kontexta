import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, lstatSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { INSTALLERS } from "../../src/hooks/installers/index.js";
import { MalformedConfigError } from "../../src/hooks/installers/json-config.js";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe.each([
  { id: "claude-code", rel: [".claude", "settings.json"], events: ["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse"], matcher: "Bash|AskUserQuestion" },
  { id: "gemini", rel: [".gemini", "settings.json"], events: ["BeforeAgent", "AfterAgent", "AfterTool"], matcher: "run_shell_command" },
  { id: "codex", rel: [".codex", "hooks.json"], events: ["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse"], matcher: "shell|local_shell|exec_command" },
])("grouped installer: $id", ({ id, rel, events, matcher }) => {
  let home: string; let dataDir: string;
  const ctx = () => ({ home, dataDir });
  const cfgPath = () => join(home, ...rel);
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-home-")); dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });

  it("fresh install writes one owned group per event, with matcher on the tool event", () => {
    const r = INSTALLERS[id].install(ctx());
    expect(r.changed).toBe(true);
    expect(r.path).toBe(cfgPath());
    const cfg = read(cfgPath());
    expect(Object.keys(cfg.hooks).sort()).toEqual([...events].sort());
    for (const ev of events) {
      expect(cfg.hooks[ev]).toHaveLength(1);
      const group = cfg.hooks[ev][0];
      expect(group.hooks).toHaveLength(1);
      expect(group.hooks[0].type).toBe("command");
      expect(group.hooks[0].command).toContain(`--agent ${id}`);
      expect(group.hooks[0].command).toContain(join(dataDir, "hooks", "emit.mjs"));
      expect(group.hooks[0].command).toContain(`--data-dir "${dataDir}"`);
    }
    const toolEvent = events[events.length - 1];
    expect(cfg.hooks[toolEvent][0].matcher).toBe(matcher);
    expect(INSTALLERS[id].status(ctx()).installed).toBe(true);
  });

  it("is idempotent", () => {
    INSTALLERS[id].install(ctx());
    const before = readFileSync(cfgPath(), "utf8");
    const r = INSTALLERS[id].install(ctx());
    expect(r.changed).toBe(false);
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
  });

  it("preserves foreign hooks and top-level keys on install and uninstall", () => {
    mkdirSync(join(home, rel[0]), { recursive: true });
    const foreign = { theme: "dark", hooks: { [events[0]]: [{ hooks: [{ type: "command", command: "echo mine" }] }], Other: [{ matcher: "X", hooks: [{ type: "command", command: "echo other" }] }] } };
    writeFileSync(cfgPath(), JSON.stringify(foreign, null, 2));
    INSTALLERS[id].install(ctx());
    let cfg = read(cfgPath());
    expect(cfg.theme).toBe("dark");
    expect(cfg.hooks[events[0]]).toHaveLength(2);
    expect(cfg.hooks[events[0]][0].hooks[0].command).toBe("echo mine");
    expect(cfg.hooks.Other[0].hooks[0].command).toBe("echo other");
    const u = INSTALLERS[id].uninstall(ctx());
    expect(u.changed).toBe(true);
    cfg = read(cfgPath());
    expect(cfg).toEqual(foreign);
    expect(INSTALLERS[id].status(ctx()).installed).toBe(false);
  });

  it("uninstall on a never-installed config is a no-op", () => {
    expect(INSTALLERS[id].uninstall(ctx()).changed).toBe(false);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("refuses to overwrite malformed JSON", () => {
    mkdirSync(join(home, rel[0]), { recursive: true });
    writeFileSync(cfgPath(), "{ not json");
    expect(() => INSTALLERS[id].install(ctx())).toThrow(MalformedConfigError);
    expect(readFileSync(cfgPath(), "utf8")).toBe("{ not json");
  });

  it("dry-run reports the change without writing", () => {
    const r = INSTALLERS[id].install({ ...ctx(), dryRun: true });
    expect(r.changed).toBe(true);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("keeps a symlinked config as a symlink and preserves the target's permissions", () => {
    if (process.platform === "win32") return;
    const dotfiles = mkdtempSync(join(tmpdir(), "kontexta-dotfiles-"));
    try {
      mkdirSync(join(home, rel[0]), { recursive: true });
      const target = join(dotfiles, "real-config.json");
      writeFileSync(target, JSON.stringify({ env: { KEY: "secret" } }));
      chmodSync(target, 0o600);
      symlinkSync(target, cfgPath());
      INSTALLERS[id].install(ctx());
      expect(lstatSync(cfgPath()).isSymbolicLink()).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      const cfg = JSON.parse(readFileSync(target, "utf8"));
      expect(cfg.env).toEqual({ KEY: "secret" });
      expect(Object.keys(cfg.hooks).length).toBeGreaterThan(0);
    } finally { rmSync(dotfiles, { recursive: true, force: true }); }
  });

  it("refuses a hooks key that is not an object instead of discarding it", () => {
    mkdirSync(join(home, rel[0]), { recursive: true });
    writeFileSync(cfgPath(), JSON.stringify({ version: 1, hooks: ["keep-me"] }));
    expect(() => INSTALLERS[id].install(ctx())).toThrow(MalformedConfigError);
    expect(JSON.parse(readFileSync(cfgPath(), "utf8")).hooks).toEqual(["keep-me"]);
  });

  it("bakes the absolute node path by default, but plain `node` for host installs", () => {
    INSTALLERS[id].install(ctx());
    expect(JSON.stringify(read(cfgPath()))).toContain(`\\"${process.execPath}\\" \\"`);
    rmSync(cfgPath(), { force: true });
    INSTALLERS[id].install({ ...ctx(), hostDataDir: "/host/kx" });
    const cmd: string = JSON.stringify(read(cfgPath()));
    expect(cmd).toContain('"command":"node \\"/host/kx/hooks/emit.mjs');
    expect(cmd).not.toContain(process.execPath);
  });

  it("quotes the node command when nodeCmd is given", () => {
    INSTALLERS[id].install({ ...ctx(), nodeCmd: "/opt/node/bin/node" });
    expect(JSON.stringify(read(cfgPath()))).toContain('\\"/opt/node/bin/node\\" \\"');
  });
});

it("codex install notes the feature gate", () => {
  const home = mkdtempSync(join(tmpdir(), "kontexta-home-")); const dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-"));
  try {
    const r = INSTALLERS.codex.install({ home, dataDir });
    expect(r.notes.join(" ")).toMatch(/codex_hooks/);
    expect(r.notes.join(" ")).toMatch(/\/hooks/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }
});
