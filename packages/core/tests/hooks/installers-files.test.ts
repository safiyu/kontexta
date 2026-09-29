import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { INSTALLERS } from "../../src/hooks/installers/index.js";
import { MalformedConfigError } from "../../src/hooks/installers/json-config.js";
import { agentMeta } from "../../src/hooks/agents.js";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
let home: string; let dataDir: string; let project: string;
const ctx = () => ({ home, dataDir, projectDir: project });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kontexta-home-")); dataDir = mkdtempSync(join(tmpdir(), "kontexta-data-")); project = mkdtempSync(join(tmpdir(), "kontexta-proj-")); });
afterEach(() => { for (const d of [home, dataDir, project]) rmSync(d, { recursive: true, force: true }); });

describe("flat installers", () => {
  it.each([
    { id: "cursor", rel: [".cursor", "hooks.json"], events: ["beforeSubmitPrompt", "afterAgentResponse", "afterShellExecution"], hinted: false },
    { id: "windsurf", rel: [".codeium", "windsurf", "hooks.json"], events: ["pre_user_prompt", "post_cascade_response", "post_run_command"], hinted: true },
  ])("$id: install / idempotent / preserve foreign / uninstall", ({ id, rel, events, hinted }) => {
    const p = join(home, ...rel);
    mkdirSync(join(home, ...rel.slice(0, -1)), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, hooks: { [events[0]]: [{ command: "echo mine" }] } }));
    expect(INSTALLERS[id].install(ctx()).changed).toBe(true);
    let cfg = read(p);
    expect(cfg.version).toBe(1);
    for (const ev of events) {
      const ours = cfg.hooks[ev].filter((e: any) => String(e.command).includes("emit.mjs"));
      expect(ours).toHaveLength(1);
      expect(ours[0].command).toContain(`--agent ${id}`);
      if (hinted) expect(ours[0].command).toContain(`--event ${ev}`); else expect(ours[0].command).not.toContain("--event");
    }
    expect(cfg.hooks[events[0]][0].command).toBe("echo mine");
    expect(INSTALLERS[id].install(ctx()).changed).toBe(false);
    expect(INSTALLERS[id].status(ctx()).installed).toBe(true);
    expect(INSTALLERS[id].uninstall(ctx()).changed).toBe(true);
    cfg = read(p);
    expect(cfg).toEqual({ version: 1, hooks: { [events[0]]: [{ command: "echo mine" }] } });
    expect(INSTALLERS[id].status(ctx()).installed).toBe(false);
  });
});

describe("flat installers — malformed hooks key", () => {
  it.each([["cursor", [".cursor", "hooks.json"]], ["windsurf", [".codeium", "windsurf", "hooks.json"]]] as const)("%s refuses a non-object hooks key", (id, rel) => {
    const p = join(home, ...rel);
    mkdirSync(join(home, ...rel.slice(0, -1)), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, hooks: "nope" }));
    expect(() => INSTALLERS[id].install(ctx())).toThrow(MalformedConfigError);
    expect(JSON.parse(readFileSync(p, "utf8")).hooks).toBe("nope");
  });
});

describe("copilot (own file under ~/.copilot/hooks)", () => {
  it("writes kontexta.json with --event per hook and removes it on uninstall", () => {
    const r = INSTALLERS.copilot.install(ctx());
    expect(r.path).toBe(join(home, ".copilot", "hooks", "kontexta.json"));
    const cfg = read(r.path);
    expect(cfg.version).toBe(1);
    expect(cfg.kontexta).toBeUndefined();
    expect(Object.keys(cfg.hooks).sort()).toEqual(["postToolUse", "subagentStop", "userPromptSubmitted"]);
    for (const [ev, list] of Object.entries<any[]>(cfg.hooks)) {
      expect(list).toHaveLength(1);
      expect(list[0].type).toBe("command");
      expect(list[0].command).toContain(`--event ${ev}`);
      expect(list[0].bash).toBeUndefined();
      expect(list[0].timeoutSec).toBe(5);
    }
    expect(INSTALLERS.copilot.install(ctx()).changed).toBe(false);
    expect(INSTALLERS.copilot.status(ctx()).installed).toBe(true);
    expect(INSTALLERS.copilot.uninstall(ctx()).changed).toBe(true);
    expect(existsSync(r.path)).toBe(false);
  });
});

describe("copilot — COPILOT_HOME", () => {
  it("writes under $COPILOT_HOME/hooks when set, but ignores it for container host installs", () => {
    const alt = mkdtempSync(join(tmpdir(), "kontexta-copilot-home-"));
    process.env.COPILOT_HOME = alt;
    try {
      const r = INSTALLERS.copilot.install(ctx());
      expect(r.path).toBe(join(alt, "hooks", "kontexta.json"));
      expect(INSTALLERS.copilot.status(ctx()).installed).toBe(true);
      const host = INSTALLERS.copilot.install({ ...ctx(), hostDataDir: "/host/kx" });
      expect(host.path).toBe(join(home, ".copilot", "hooks", "kontexta.json"));
    } finally { delete process.env.COPILOT_HOME; rmSync(alt, { recursive: true, force: true }); }
  });
});

describe("kiro", () => {
  it("has no installer until its hook config format is verified, and is not advertised as hook-capable", () => {
    expect(INSTALLERS.kiro).toBeUndefined();
    expect(agentMeta("kiro")!.hooksSupported).toBe(false);
  });
});

describe("cline (executable shims)", () => {
  it("writes executable shims and refuses to clobber a foreign hook", () => {
    const dir = join(home, "Documents", "Cline", "Hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PostToolUse"), "#!/bin/sh\necho mine\n");
    const r = INSTALLERS.cline.install(ctx());
    expect(r.changed).toBe(true);
    const shim = readFileSync(join(dir, "UserPromptSubmit"), "utf8");
    expect(shim.split(/\r?\n/)[0]).toBe("#!/bin/sh");
    expect(shim).toContain("# kontexta-hooks");
    expect(shim).toContain("--agent cline");
    if (process.platform !== "win32") expect(statSync(join(dir, "UserPromptSubmit")).mode & 0o111).toBeTruthy();
    expect(readFileSync(join(dir, "PostToolUse"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(r.notes.join(" ")).toMatch(/PostToolUse/);
    expect(INSTALLERS.cline.status(ctx()).installed).toBe(false);
    expect(INSTALLERS.cline.uninstall(ctx()).changed).toBe(true);
    expect(existsSync(join(dir, "UserPromptSubmit"))).toBe(false);
    expect(existsSync(join(dir, "PostToolUse"))).toBe(true);
  });
});

describe("opencode (TypeScript plugin)", () => {
  it("writes a plugin that transpiles and points at the staged emitter", () => {
    const r = INSTALLERS.opencode.install(ctx());
    expect(r.path).toBe(join(home, ".config", "opencode", "plugins", "kontexta.ts"));
    const src = readFileSync(r.path, "utf8");
    expect(src.split(/\r?\n/)[0]).toBe("// kontexta-hooks");
    expect(src).toContain(join(dataDir, "hooks", "emit.mjs").replace(/\\/g, "\\\\"));
    expect(src).toContain('"chat.message"');
    expect(src).toContain('"tool.execute.after"');
    expect(src).toContain("directory ?? process.cwd()");
    const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    expect(out.diagnostics ?? []).toHaveLength(0);
    expect(INSTALLERS.opencode.install(ctx()).changed).toBe(false);
    expect(INSTALLERS.opencode.uninstall(ctx()).changed).toBe(true);
    expect(existsSync(r.path)).toBe(false);
  });
});

it("INSTALLERS covers exactly the hook-capable agents that have a verified installer", () => {
  expect(Object.keys(INSTALLERS).sort()).toEqual(["claude-code", "cline", "codex", "copilot", "cursor", "gemini", "opencode", "windsurf"]);
});
