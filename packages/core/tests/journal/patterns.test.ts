import { describe, it, expect } from "vitest";
import { runPatterns } from "../../src/journal/patterns/index.js";
import type { RawEvent } from "../../src/journal/types.js";

function ev(overrides: Partial<RawEvent>): RawEvent {
  return {
    ts: "2026-05-12T16:00:00Z",
    agent: "claude-code",
    sid: "s",
    event: "tool_call",
    tool: "update_file",
    args: {},
    touched: [],
    status: "ok",
    ms: 10,
    ...overrides,
  };
}

describe("error-recovery-cycle pattern", () => {
  it("matches when an error is followed by a successful same-file edit", () => {
    const events = [
      ev({ event: "error", touched: ["a.ts"], ts: "2026-05-12T16:00:00Z" }),
      ev({ touched: ["a.ts"], ts: "2026-05-12T16:01:00Z" }),
    ];
    const matches = runPatterns(events);
    const m = matches.find((p) => p.name === "error-recovery-cycle");
    expect(m).toBeDefined();
    expect(m!.tags).toContain("resolved");
  });

  it("marks unresolved if errors continue after the last error", () => {
    const events = [
      ev({ event: "error", touched: ["a.ts"], ts: "2026-05-12T16:00:00Z" }),
    ];
    const m = runPatterns(events).find((p) => p.name === "error-recovery-cycle");
    expect(m?.tags).toContain("unresolved");
  });

  it("does not match when there are no errors", () => {
    const events = [ev({ touched: ["a.ts"] })];
    expect(runPatterns(events).find((p) => p.name === "error-recovery-cycle")).toBeUndefined();
  });
});

describe("exploration pattern", () => {
  it("matches when ≥5 reads with no writes", () => {
    const events = Array.from({ length: 6 }).map((_, i) =>
      ev({ tool: "search", touched: [`f${i}.ts`], ts: `2026-05-12T16:0${i}:00Z` })
    );
    const m = runPatterns(events).find((p) => p.name === "exploration");
    expect(m).toBeDefined();
  });

  it("does not match when any write occurred", () => {
    const events = [
      ...Array.from({ length: 6 }).map((_, i) =>
        ev({ tool: "search", touched: [`f${i}.ts`], ts: `2026-05-12T16:0${i}:00Z` })
      ),
      ev({ tool: "update_file", touched: ["g.ts"] }),
    ];
    expect(runPatterns(events).find((p) => p.name === "exploration")).toBeUndefined();
  });
});

describe("test-cycle pattern", () => {
  it("matches with at least one test edit and one test run", () => {
    const events = [
      ev({ tool: "update_file", touched: ["foo.test.ts"] }),
      ev({ tool: "hands", args: { name: "pnpm test" }, touched: [] }),
    ];
    const m = runPatterns(events).find((p) => p.name === "test-cycle");
    expect(m).toBeDefined();
  });
});

describe("pivot pattern", () => {
  it("matches when a user_intent event is present", () => {
    const events = [ev({ event: "user_intent", summary: "switch to plan B", tool: undefined })];
    const m = runPatterns(events).find((p) => p.name === "pivot");
    expect(m).toBeDefined();
  });
});

describe("build-failure-recovery pattern", () => {
  it("matches when a failed build run is followed by a passing one with edits between", () => {
    const events = [
      ev({ tool: "hands", args: { name: "pnpm build" }, status: "error", ts: "2026-05-12T16:00:00Z" }),
      ev({ tool: "update_file", touched: ["a.ts"], ts: "2026-05-12T16:01:00Z" }),
      ev({ tool: "hands", args: { name: "pnpm build" }, status: "ok", ts: "2026-05-12T16:02:00Z" }),
    ];
    const m = runPatterns(events).find((p) => p.name === "build-failure-recovery");
    expect(m).toBeDefined();
  });
});
