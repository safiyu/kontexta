import { describe, it, expect } from "vitest";
import { runPatterns } from "../../src/journal/patterns/index.js";
import type { RawEvent } from "../../src/journal/types.js";

function ev(o: Partial<RawEvent>): RawEvent {
  return {
    ts: "2026-05-12T16:00:00Z",
    agent: "claude-code", sid: "s", event: "tool_call",
    tool: "update_file", args: {}, touched: [], status: "ok", ms: 10,
    ...o,
  };
}

describe("refactor pattern", () => {
  it("matches when ≥2 moves and a refactor commit are present", () => {
    const events = [
      ev({ tool: "move_file", touched: ["lib/a.ts"], ts: "2026-05-12T16:00:00Z" }),
      ev({ tool: "move_file", touched: ["lib/b.ts"], ts: "2026-05-12T16:01:00Z" }),
      ev({ tool: "update_file", touched: ["lib/c.ts"], ts: "2026-05-12T16:02:00Z" }),
      ev({ tool: "update_file", touched: ["lib/d.ts"], ts: "2026-05-12T16:03:00Z" }),
      ev({ event: "git_commit", sha: "abc1234", msg: "refactor(lib): split foo", tool: undefined, ts: "2026-05-12T16:04:00Z" }),
    ];
    const m = runPatterns(events).find((p) => p.name === "refactor");
    expect(m).toBeDefined();
    expect(m!.tags).toContain("committed");
  });

  it("does not match without enough activity", () => {
    const events = [ev({ tool: "move_file", touched: ["lib/a.ts"] })];
    expect(runPatterns(events).find((p) => p.name === "refactor")).toBeUndefined();
  });
});

describe("incident-response pattern", () => {
  it("matches on a fix/INC- branch", () => {
    const events = [
      ev({ event: "git_context", branch: "fix/INC-9999-meltdown", tool: undefined }),
      ev({ event: "error", touched: ["a.ts"] }),
    ];
    expect(runPatterns(events).find((p) => p.name === "incident-response")).toBeDefined();
  });

  it("does not match on a regular branch", () => {
    const events = [
      ev({ event: "git_context", branch: "main", tool: undefined }),
      ev({ event: "error", touched: ["a.ts"] }),
    ];
    expect(runPatterns(events).find((p) => p.name === "incident-response")).toBeUndefined();
  });
});

describe("feature-development pattern", () => {
  it("matches on a feat/ branch with feat: commits", () => {
    const events = [
      ev({ event: "git_context", branch: "feat/NEW-1", tool: undefined }),
      ev({ event: "git_commit", sha: "x", msg: "feat: add thing", tool: undefined }),
    ];
    expect(runPatterns(events).find((p) => p.name === "feature-development")).toBeDefined();
  });
});

describe("tagging-pass pattern", () => {
  it("matches when ≥3 tag operations dominate the window", () => {
    const events = Array.from({ length: 4 }).map((_, i) =>
      ev({ tool: "add_tags", ts: `2026-05-12T16:0${i}:00Z` })
    );
    expect(runPatterns(events).find((p) => p.name === "tagging-pass")).toBeDefined();
  });

  it("does not match if writes outnumber tag ops", () => {
    const events = [
      ev({ tool: "add_tags" }),
      ev({ tool: "update_file" }),
      ev({ tool: "update_file" }),
    ];
    expect(runPatterns(events).find((p) => p.name === "tagging-pass")).toBeUndefined();
  });
});

describe("read-only-investigation pattern", () => {
  it("matches when ≥3 calls and all are read-only", () => {
    const events = [
      ev({ tool: "search" }),
      ev({ tool: "read_file" }),
      ev({ tool: "describe_file" }),
    ];
    expect(runPatterns(events).find((p) => p.name === "read-only-investigation")).toBeDefined();
  });

  it("does not match if any write occurred", () => {
    const events = [
      ev({ tool: "search" }),
      ev({ tool: "search" }),
      ev({ tool: "search" }),
      ev({ tool: "update_file" }),
    ];
    expect(runPatterns(events).find((p) => p.name === "read-only-investigation")).toBeUndefined();
  });
});
