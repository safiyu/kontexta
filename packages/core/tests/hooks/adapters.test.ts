import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const EMIT = resolve(__dirname, "../../src/hooks/emit.mjs");
const FIX = resolve(__dirname, "fixtures");
const load = (agent: string, name: string) => JSON.parse(readFileSync(join(FIX, agent, `${name}.json`), "utf8"));

type Case = { agent: string; fixture: string; hint?: string; expect: Record<string, unknown> | null };
const CASES: Case[] = [
  { agent: "codex", fixture: "post-bash", expect: { event: "shell", command: "gh pr create --fill", sid: "c1" } },
  { agent: "codex", fixture: "post-apply-patch", expect: null },
  { agent: "hermes", fixture: "pre-llm-call", expect: { event: "user_prompt", text: "Check the SLT replication lag", sid: "sess_abc123" } },
  { agent: "hermes", fixture: "pre-llm-call-multimodal", expect: { event: "user_prompt", text: "What is in\nthis chart?" } },
  { agent: "hermes", fixture: "post-llm-call", expect: { event: "agent_reply", text: "Lag is 4m on MARD.", sid: "sess_abc123" } },
  { agent: "hermes", fixture: "post-tool-terminal", expect: { event: "shell", command: "gcloud auth list" } },
  { agent: "hermes", fixture: "post-tool-other", expect: null },
  { agent: "hermes", fixture: "subagent-stop", expect: { event: "agent_reply", text: "Found 3 failing jobs.", subagent: true } },
  { agent: "antigravity", fixture: "post-run-command", expect: { event: "shell", command: "npm test", sid: "ec33ebf9-0cba-4100-8142-c61503f6c587" } },
  { agent: "antigravity", fixture: "post-ask-question", expect: { event: "agent_question", questions: [{ question: "Which environment?" }] } },
  { agent: "antigravity", fixture: "post-view-file", expect: null },
  { agent: "antigravity", fixture: "stop", expect: null },
  { agent: "gemini", fixture: "before-agent", expect: { event: "user_prompt", text: "Summarise the SLT run mail", sid: "g1" } },
  { agent: "gemini", fixture: "after-agent", expect: { event: "agent_reply", text: "All green except MARD lag 4m.", sid: "g1" } },
  { agent: "gemini", fixture: "after-tool-shell", expect: { event: "shell", command: "gcloud auth list", sid: "g1" } },
  { agent: "codex", fixture: "prompt", expect: { event: "user_prompt", text: "Open a PR for the drift fix", sid: "c1" } },
  { agent: "codex", fixture: "stop", expect: { event: "agent_reply", text: "PR #305 opened.", sid: "c1" } },
  { agent: "codex", fixture: "post-shell", expect: { event: "shell", command: "gh pr create --fill", sid: "c1" } },
  { agent: "copilot", fixture: "prompt", hint: "userPromptSubmitted", expect: { event: "user_prompt", text: "List failing checks", sid: "p1" } },
  { agent: "copilot", fixture: "subagent-stop", hint: "subagentStop", expect: { event: "agent_reply", text: "Two checks failing: lint, e2e.", sid: "p1", subagent: true } },
  { agent: "copilot", fixture: "post-bash", hint: "postToolUse", expect: { event: "shell", command: "gh run list --limit 5", sid: "p1" } },
  { agent: "copilot", fixture: "prompt", expect: { event: "user_prompt", sid: "p1" } },
  { agent: "copilot", fixture: "post-powershell", hint: "postToolUse", expect: { event: "shell", command: "Get-ChildItem C:\\work", sid: "p1" } },
  { agent: "cursor", fixture: "prompt", expect: { event: "user_prompt", text: "Refactor the retry loop", sid: "u1" } },
  { agent: "cursor", fixture: "response", expect: { event: "agent_reply", text: "Done — extracted withRetry().", sid: "u1" } },
  { agent: "cursor", fixture: "shell", expect: { event: "shell", command: "pnpm test", sid: "u1" } },
  { agent: "windsurf", fixture: "prompt", expect: { event: "user_prompt", text: "Check the bootstrap gate", sid: "w1" } },
  { agent: "windsurf", fixture: "response", hint: "post_cascade_response", expect: { event: "agent_reply", sid: "w1" } },
  { agent: "windsurf", fixture: "run-command", hint: "post_run_command", expect: { event: "shell", command: "bq ls itg-btdpslt-gbl-ww-dv:stds_probe", sid: "w1" } },
  { agent: "windsurf", fixture: "response", expect: null },
  { agent: "kiro", fixture: "prompt", expect: { event: "user_prompt", sid: "k1" } },
  { agent: "kiro", fixture: "post-bash", expect: { event: "shell", command: "ls -la", sid: "k1" } },
  { agent: "kiro", fixture: "prompt-no-session", expect: { event: "user_prompt", text: "hi from kiro", sid: "/tmp/work" } },
  { agent: "kiro", fixture: "post-shell", expect: { event: "shell", command: "ls -la", sid: "/tmp/work" } },
  { agent: "cline", fixture: "prompt", expect: { event: "user_prompt", text: "Fix black import order", sid: "l1" } },
  { agent: "cline", fixture: "post-exec", expect: { event: "shell", command: "black modules/sltdecode", sid: "l1" } },
  { agent: "opencode", fixture: "prompt", expect: { event: "user_prompt", text: "Add the stocks POC runbook", sid: "o1" } },
  { agent: "opencode", fixture: "shell", expect: { event: "shell", command: "pytest -q", sid: "o1" } },
];

describe("adapters", () => {
  for (const c of CASES) {
    it(`${c.agent}/${c.fixture}${c.hint ? ` (--event ${c.hint})` : ""}`, async () => {
      const { ADAPTERS } = await import(EMIT);
      const out = ADAPTERS[c.agent](load(c.agent, c.fixture), c.hint);
      if (c.expect === null) { expect(out).toEqual([]); return; }
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject(c.expect);
    });
  }

  it("every supported agent has an adapter and nothing else does", async () => {
    const { ADAPTERS } = await import(EMIT);
    expect(Object.keys(ADAPTERS).sort()).toEqual(["antigravity", "claude-code", "cline", "codex", "copilot", "cursor", "gemini", "hermes", "kiro", "opencode", "windsurf"]);
  });

  it("--event hint is plumbed through the CLI (windsurf)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kontexta-emit-hint-"));
    try {
      const r = spawnSync(process.execPath, [EMIT, "--data-dir", dataDir, "--agent", "windsurf", "--event", "post_run_command"], {
        input: readFileSync(join(FIX, "windsurf", "run-command.json"), "utf8"), encoding: "utf8", env: { PATH: process.env.PATH ?? "" },
      });
      expect(r.status).toBe(0);
      const raw = join(dataDir, "knowledge", "journal", "default", "raw");
      const line = JSON.parse(readFileSync(join(raw, readdirSync(raw)[0]), "utf8").trim());
      expect(line).toMatchObject({ event: "shell", agent: "windsurf", cwd: "/tmp/work" });
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
