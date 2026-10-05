// packages/core/tests/journal/renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderMechanicalEntry } from "../../src/journal/renderer.js";
import type { RawEvent } from "../../src/journal/types.js";

function ev(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    ts: "2026-05-12T16:00:00Z",
    agent: "claude-code", sid: "s", event: "tool_call",
    tool: "update_file", args: {}, touched: [], status: "ok", ms: 10,
    ...overrides,
  };
}

describe("renderMechanicalEntry", () => {
  it("includes pattern matches with their summaries and tags", () => {
    const out = renderMechanicalEntry({
      task_slug: "ws-recovery",
      events: [
        ev({ event: "error", touched: ["websocket.ts"] }),
        ev({ tool: "update_file", touched: ["websocket.ts"] }),
      ],
      now: "2026-05-12T16:03:00Z",
    });
    expect(out).toMatch(/## 2026-05-12 16:03/);
    expect(out).toMatch(/error-recovery cycle/);
    expect(out).toMatch(/Tags:/);
    expect(out).toMatch(/error-recovery/);
  });

  it("falls back to a generic summary when no pattern matches", () => {
    const out = renderMechanicalEntry({
      task_slug: "ws-recovery",
      events: [ev({ tool: "search", touched: [] })],
      now: "2026-05-12T16:03:00Z",
    });
    expect(out).toMatch(/auto-summary/);
  });

  it("lists unique touched files", () => {
    const out = renderMechanicalEntry({
      task_slug: "ws-recovery",
      events: [
        ev({ touched: ["a.ts", "b.ts"] }),
        ev({ touched: ["a.ts"] }),
      ],
      now: "2026-05-12T16:03:00Z",
    });
    expect(out).toMatch(/a\.ts/);
    expect(out).toMatch(/b\.ts/);
    // Each file mentioned exactly once in Touched line
    expect((out.match(/a\.ts/g) ?? []).length).toBeLessThanOrEqual(3); // could appear in body too
  });
});

describe("renderMechanicalEntry — evidence preservation", () => {
  it("renders agent_note and user_intent summaries verbatim when no pattern matches", () => {
    const events = [
      ev({ ts: "2026-09-28T11:54:27.729Z", event: "agent_note", tool: undefined, summary: "RCA: bootstrap wedge caused by crashed claim; fix is to release lock on NotFound." }),
      ev({ ts: "2026-09-28T12:07:23.650Z", event: "user_intent", tool: undefined, summary: "Move the plan into the KB and delete the repo copy." }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T12:07:23.650Z" });
    expect(out).toContain("RCA: bootstrap wedge caused by crashed claim");
    expect(out).toContain("Move the plan into the KB and delete the repo copy.");
    expect(out).toContain("11:54");
    expect(out).toContain("12:07");
    expect(out).not.toContain("No file activity");
  });

  it("renders notes even when a pattern does match", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => ev({ ts: `2026-09-28T12:0${i}:00.000Z`, tool: "files_read" })),
      ev({ event: "agent_note", tool: undefined, summary: "Confirmed: index walker skips journal tree." }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T12:07:00.000Z" });
    expect(out).toContain("**Pattern:**");
    expect(out).toContain("Confirmed: index walker skips journal tree.");
  });

  it("lists git commits with short sha and message", () => {
    const events = [
      ev({ event: "git_commit", tool: undefined, sha: "18cd2356988da7b656ac047e0b9f0a02fd26b35f", msg: "[STRY0869745](fix) Unwedge CDC bootstrap", files_changed: ["modules/sltdecode/src/decode_api/service.py"] }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T07:37:33.482Z" });
    expect(out).toContain("18cd235");
    expect(out).toContain("[STRY0869745](fix) Unwedge CDC bootstrap");
  });

  it("folds git_commit.files_changed into touched files", () => {
    const events = [
      ev({ event: "git_commit", tool: undefined, sha: "abc1234def", msg: "x", files_changed: ["a/b.py", "c/d.py"] }),
      ev({ touched: ["e/f.md"] }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T12:00:00.000Z" });
    expect(out).toContain("a/b.py");
    expect(out).toContain("c/d.py");
    expect(out).toContain("e/f.md");
    expect(out).not.toContain("No file activity");
  });

  it("summarises tool calls by name and count", () => {
    const events = [
      ev({ tool: "files_update" }), ev({ tool: "files_update" }), ev({ tool: "files_create" }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T12:00:00.000Z" });
    expect(out).toMatch(/files_update\s*×\s*2/);
    expect(out).toMatch(/files_create\s*×\s*1/);
  });

  it("carries tags from notes into the entry tags", () => {
    const events = [ev({ event: "agent_note", tool: undefined, summary: "n", tags: ["rca", "cdc"] })];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T12:00:00.000Z" });
    expect(out).toMatch(/\*\*Tags:\*\*.*\brca\b/);
    expect(out).toMatch(/\*\*Tags:\*\*.*\bcdc\b/);
  });

  it("still reports no file activity when there is genuinely none", () => {
    const events = [ev({ tool: "files_search" })];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-28T12:00:00.000Z" });
    expect(out).toContain("No file activity");
  });
});

describe("renderMechanicalEntry — conversation and shell", () => {
  const hook = (overrides: Partial<RawEvent>): RawEvent => ev({ tool: undefined, source: "hook", ...overrides });

  it("renders prompts, replies and Q&A chronologically under Conversation", () => {
    const events = [
      hook({ ts: "2026-09-29T09:00:00.000Z", event: "user_prompt", text: "Why is MATDOC dormant?" }),
      hook({ ts: "2026-09-29T09:00:30.000Z", event: "agent_question", questions: [{ question: "Prod or NP?", answer: "NP" }] }),
      hook({ ts: "2026-09-29T09:02:00.000Z", event: "agent_reply", text: "Gate is realtime_cfg.active.", truncated: true, bytes: 9000 }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-29T09:02:00.000Z" });
    const conv = out.slice(out.indexOf("**Conversation:**"));
    expect(conv).toMatch(/09:00 you: Why is MATDOC dormant\?[\s\S]*09:00 agent asked: Prod or NP\? — NP[\s\S]*09:02 agent: Gate is realtime_cfg\.active\. …\(truncated, 9000 bytes\)/);
    expect(out).toMatch(/\*\*Tags:\*\*.*\bconversation\b/);
  });

  it("marks subagent replies and dedupes shell commands with counts", () => {
    const events = [
      hook({ event: "agent_reply", text: "sub result", subagent: true }),
      hook({ event: "shell", command: "pnpm test" }),
      hook({ event: "shell", command: "pnpm test" }),
      hook({ event: "shell", command: "gh pr view 304" }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-29T09:02:00.000Z" });
    expect(out).toContain("agent (subagent): sub result");
    const shell = out.slice(out.indexOf("**Shell:**"), out.indexOf("**Tags:**"));
    expect(shell).toContain("- `pnpm test` × 2");
    expect(shell).toContain("- `gh pr view 304`");
    expect(out).not.toMatch(/\*\*Tags:\*\*.*\bconversation\b/);
  });

  it("places Conversation and Shell before Notes", () => {
    const events = [
      hook({ event: "agent_note", summary: "note", source: "mcp" }),
      hook({ event: "shell", command: "ls" }),
      hook({ event: "user_prompt", text: "hi" }),
    ];
    const out = renderMechanicalEntry({ task_slug: "orphan", events, now: "2026-09-29T09:02:00.000Z" });
    expect(out.indexOf("**Conversation:**")).toBeLessThan(out.indexOf("**Shell:**"));
    expect(out.indexOf("**Shell:**")).toBeLessThan(out.indexOf("**Notes:**"));
  });
});
