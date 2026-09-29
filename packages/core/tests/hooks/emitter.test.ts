import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defaultRedactConfig } from "../../src/journal/redact.js";
import { defaultDataDir as coreDefaultDataDir } from "../../src/util/paths.js";

const EMIT = resolve(__dirname, "../../src/hooks/emit.mjs");
const FIX = resolve(__dirname, "fixtures");
const fixture = (agent: string, name: string) => readFileSync(join(FIX, agent, `${name}.json`), "utf8");

function runEmit(dataDir: string, args: string[], stdin: string, env: Record<string, string> = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [EMIT, "--data-dir", dataDir, ...args], {
    input: stdin, encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return { ...r, ms: Date.now() - started };
}

function rawLines(dataDir: string, slug = "default"): any[] {
  const dir = join(dataDir, "knowledge", "journal", slug, "raw");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

describe("emit.mjs — contract", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kontexta-emit-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("writes a user_prompt with the normalised envelope", () => {
    const r = runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "user-prompt"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const [ev] = rawLines(dataDir);
    expect(ev).toMatchObject({ event: "user_prompt", agent: "claude-code", sid: "claude-code:s1", source: "hook", cwd: "/tmp/work", text: "Why does CDC bootstrap wedge after a crash?" });
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(ev.branch).toBeUndefined();
  });

  it("maps Stop and SubagentStop to agent_reply", () => {
    runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "stop"));
    runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "subagent-stop"));
    const [a, b] = rawLines(dataDir);
    expect(a).toMatchObject({ event: "agent_reply", text: expect.stringContaining("Root cause") });
    expect(a.subagent).toBeUndefined();
    expect(b).toMatchObject({ event: "agent_reply", subagent: true });
  });

  it("maps PostToolUse Bash to shell and ignores other tools", () => {
    runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "post-bash"));
    runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "post-other"));
    const lines = rawLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "shell", command: "bq query --use_legacy_sql=false 'SELECT 1'" });
    expect(lines[0].text).toBeUndefined();
  });

  it("maps AskUserQuestion to agent_question with answers", () => {
    runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "post-ask"));
    const [ev] = rawLines(dataDir);
    expect(ev.event).toBe("agent_question");
    expect(ev.questions).toEqual([{ question: "How much should the journal keep?", answer: "no need of the code. bash commands is good to have" }]);
  });

  it("swallows garbage and oversized stdin", () => {
    const g = runEmit(dataDir, ["--agent", "claude-code"], "not json {{{");
    expect(g.status).toBe(0); expect(g.stdout).toBe("");
    const big = runEmit(dataDir, ["--agent", "claude-code"], "x".repeat(2_000_000));
    expect(big.status).toBe(0); expect(big.stdout).toBe("");
    expect(big.ms).toBeLessThan(1000);
    expect(rawLines(dataDir)).toHaveLength(0);
    const none = runEmit(dataDir, [], fixture("claude-code", "user-prompt"));
    expect(none.status).toBe(0); expect(none.stdout).toBe("");
    expect(rawLines(dataDir)).toHaveLength(0);
  });

  it("caps on a UTF-8 boundary after redaction", () => {
    const secret = "ghp_" + "a".repeat(36);
    const prompt = `use ${secret} then ` + "é".repeat(6000);
    const payload = JSON.stringify({ session_id: "s1", cwd: "/tmp/work", hook_event_name: "UserPromptSubmit", prompt });
    runEmit(dataDir, ["--agent", "claude-code"], payload);
    const [ev] = rawLines(dataDir);
    expect(ev.text).not.toContain("ghp_");
    expect(ev.text).toContain("<redacted>");
    expect(ev.truncated).toBe(true);
    expect(ev.bytes).toBeGreaterThan(8192);
    expect(Buffer.byteLength(ev.text, "utf8")).toBeLessThanOrEqual(8192);
    expect(ev.text.includes("�")).toBe(false);
  });

  it("honours caps from kontexta.json", () => {
    writeFileSync(join(dataDir, "kontexta.json"), JSON.stringify({ journal: { hooks: { prompt_max_bytes: 16 } } }));
    runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "user-prompt"));
    const [ev] = rawLines(dataDir);
    expect(Buffer.byteLength(ev.text, "utf8")).toBeLessThanOrEqual(16);
    expect(ev.truncated).toBe(true);
  });

  it("falls back to default slug without branch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kontexta-nogit-"));
    try {
      const payload = JSON.stringify({ session_id: "s2", cwd, hook_event_name: "UserPromptSubmit", prompt: "hi" });
      runEmit(dataDir, ["--agent", "claude-code"], payload);
      const lines = rawLines(dataDir, "default");
      expect(lines).toHaveLength(1);
      expect(lines[0].branch).toBeUndefined();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("resolves slug from projects.json (longest prefix) and branch from .git/HEAD, emitting git_context once per change", () => {
    const repo = mkdtempSync(join(tmpdir(), "kontexta-repo-"));
    try {
      mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
      writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/fix/STRY-1-wedge\n");
      mkdirSync(join(repo, "sub", "deep"), { recursive: true });
      mkdirSync(join(dataDir, "hooks"), { recursive: true });
      writeFileSync(join(dataDir, "hooks", "projects.json"), JSON.stringify({ version: 1, projects: [{ slug: "outer", path: repo }, { slug: "inner", path: join(repo, "sub") }] }));
      const p = (n: number) => JSON.stringify({ session_id: "s3", cwd: join(repo, "sub", "deep"), hook_event_name: "UserPromptSubmit", prompt: `p${n}` });
      runEmit(dataDir, ["--agent", "claude-code"], p(1));
      runEmit(dataDir, ["--agent", "claude-code"], p(2));
      let lines = rawLines(dataDir, "inner");
      expect(lines.map((l) => l.event)).toEqual(["git_context", "user_prompt", "user_prompt"]);
      expect(lines[0]).toMatchObject({ branch: "fix/STRY-1-wedge", source: "hook" });
      expect(lines[1].branch).toBe("fix/STRY-1-wedge");
      writeFileSync(join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
      runEmit(dataDir, ["--agent", "claude-code"], p(3));
      lines = rawLines(dataDir, "inner");
      expect(lines.filter((l) => l.event === "git_context")).toHaveLength(2);
      expect(lines[lines.length - 1].branch).toBe("0123456");
      const wt = mkdtempSync(join(tmpdir(), "kontexta-wt-"));
      writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git")}\n`);
      runEmit(dataDir, ["--agent", "claude-code"], JSON.stringify({ session_id: "s4", cwd: wt, hook_event_name: "UserPromptSubmit", prompt: "wt" }));
      expect(rawLines(dataDir, "default").at(-1)!.branch).toBe("0123456");
      rmSync(wt, { recursive: true, force: true });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("parallel appends stay line-atomic", async () => {
    const payload = (i: number) => JSON.stringify({ session_id: "par", cwd: "/tmp/work", hook_event_name: "UserPromptSubmit", prompt: `p${i} ` + "z".repeat(3000) });
    await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise<void>((res) => {
      const c = spawn(process.execPath, [EMIT, "--data-dir", dataDir, "--agent", "claude-code"], { env: { PATH: process.env.PATH ?? "" } });
      c.on("exit", () => res()); c.stdin.end(payload(i));
    })));
    const lines = rawLines(dataDir);
    expect(lines).toHaveLength(20);
    expect(new Set(lines.map((l) => l.text.slice(0, 4))).size).toBe(20);
  });

  it("prefers KONTEXTA_DATA_DIR over --data-dir", () => {
    const other = mkdtempSync(join(tmpdir(), "kontexta-emit-env-"));
    try {
      runEmit(dataDir, ["--agent", "claude-code"], fixture("claude-code", "user-prompt"), { KONTEXTA_DATA_DIR: other });
      expect(rawLines(dataDir)).toHaveLength(0);
      expect(rawLines(other)).toHaveLength(1);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe("emit.mjs — parity with core", () => {
  it("uses the same blocked-key regex as core's redactor", () => {
    const src = readFileSync(EMIT, "utf8");
    const m = src.match(/const BLOCKED_KEY_RE = (\/.*\/[a-z]*);/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(defaultRedactConfig.blockedKeyRegex.toString());
  });

  it("computes the same OS default data dir as core", async () => {
    const mod = await import(EMIT);
    expect(mod.defaultDataDir()).toBe(coreDefaultDataDir());
  });

  it("capUtf8 never splits a code point", async () => {
    const { capUtf8 } = await import(EMIT);
    const r = capUtf8("aé€😀", 6);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("aé€");
    expect(capUtf8("abc", 10)).toEqual({ text: "abc", truncated: false, bytes: 3 });
  });
});

describe("emit.mjs — redaction of common shell/prompt secret shapes", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kontexta-redact-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  const cases: Array<[string, string]> = [
    ["curl -u admin:Hunter2! https://x.example", "Hunter2!"],
    ["mysql -h db --password=S3cret2 -e 'select 1'", "S3cret2"],
    ["export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMIK7MDENG"],
    ['curl -H "authorization: bearer abcdef0123456789abcdef" https://x', "abcdef0123456789abcdef"],
    ["psql postgres://appuser:pa55w0rd@db.internal/prod", "pa55w0rd"],
    ["stripe sk_live_51H8abcdefghijklmnop", "sk_live_51H8abcdefghijklmnop"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGciOiJIUzI1NiJ9"],
    ["my db password is hunter2", "hunter2"],
    ["glab auth login --token glpat-abcdefghij0123456789", "glpat-abcdefghij0123456789"],
    ['TOKEN="abc def ghi" ./run.sh', "abc def ghi"],
  ];

  it.each(cases)("scrubs %s", (text, secret) => {
    runEmit(dataDir, ["--agent", "claude-code"], JSON.stringify({ session_id: "r", cwd: "/tmp/work", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: text } }));
    runEmit(dataDir, ["--agent", "claude-code"], JSON.stringify({ session_id: "r", cwd: "/tmp/work", hook_event_name: "UserPromptSubmit", prompt: text }));
    const lines = rawLines(dataDir);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      const written = l.command ?? l.text;
      expect(written).not.toContain(secret);
      expect(written).toContain("<redacted>");
    }
  });

  it("scrubs secrets inside agent question answers", () => {
    const payload = JSON.parse(fixture("claude-code", "post-ask"));
    payload.tool_response.answers = { "How much should the journal keep?": "use password: hunter2 for the db" };
    runEmit(dataDir, ["--agent", "claude-code"], JSON.stringify(payload));
    expect(JSON.stringify(rawLines(dataDir)[0].questions)).not.toContain("hunter2");
  });

  it("leaves ordinary commands and prose alone", () => {
    for (const ok of ["ls -la /tmp", 'git commit -m "fix token refresh flow"', "pnpm test --filter core", 'echo "a: b"']) {
      runEmit(dataDir, ["--agent", "claude-code"], JSON.stringify({ session_id: "o", cwd: "/tmp/work", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: ok } }));
    }
    expect(rawLines(dataDir).map((l) => l.command)).toEqual(["ls -la /tmp", 'git commit -m "fix token refresh flow"', "pnpm test --filter core", 'echo "a: b"']);
  });
});

describe("emit.mjs — input robustness", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kontexta-robust-")); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it("uses Cline's workspaceRoots for project and cwd resolution", () => {
    const repo = mkdtempSync(join(tmpdir(), "kontexta-cline-repo-"));
    try {
      mkdirSync(join(dataDir, "hooks"), { recursive: true });
      writeFileSync(join(dataDir, "hooks", "projects.json"), JSON.stringify({ version: 1, projects: [{ slug: "clineproj", path: repo }] }));
      runEmit(dataDir, ["--agent", "cline"], JSON.stringify({ hookName: "UserPromptSubmit", taskId: "l2", workspaceRoots: [repo], userPromptSubmit: { prompt: "x" } }));
      const [ev] = rawLines(dataDir, "clineproj");
      expect(ev).toMatchObject({ event: "user_prompt", cwd: repo });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("matches Windows-style paths in projects.json (separators and drive-letter case)", async () => {
    mkdirSync(join(dataDir, "hooks"), { recursive: true });
    writeFileSync(join(dataDir, "hooks", "projects.json"), JSON.stringify({ version: 1, projects: [{ slug: "win", path: "C:\\Users\\me\\proj" }] }));
    const { slugFor } = await import(EMIT);
    expect(slugFor("C:\\Users\\Me\\proj\\sub", dataDir)).toBe("win");
    expect(slugFor("c:/users/me/proj", dataDir)).toBe("win");
    expect(slugFor("C:\\Users\\me\\proj-2", dataDir)).toBe("default");
  });

  it("gives up on a stdin that never closes instead of hanging the agent", async () => {
    const started = Date.now();
    const child = spawn(process.execPath, [EMIT, "--data-dir", dataDir, "--agent", "claude-code"], {
      stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", KONTEXTA_HOOK_STDIN_TIMEOUT_MS: "300" },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    const code = await new Promise<number | null>((res) => {
      const guard = setTimeout(() => { child.kill("SIGKILL"); res(-1); }, 6000);
      child.on("exit", (c) => { clearTimeout(guard); res(c); });
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(Date.now() - started).toBeLessThan(5500);
    expect(rawLines(dataDir)).toHaveLength(0);
  });

  it("does not stall on a very long unbroken token (regex safety)", () => {
    const payload = JSON.stringify({ session_id: "long", cwd: "/tmp/work", hook_event_name: "UserPromptSubmit", prompt: "a".repeat(900_000) });
    const r = runEmit(dataDir, ["--agent", "claude-code"], payload);
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(4000);
    const [ev] = rawLines(dataDir);
    expect(ev.truncated).toBe(true);
    expect(Buffer.byteLength(ev.text, "utf8")).toBeLessThanOrEqual(8192);
  });
});
