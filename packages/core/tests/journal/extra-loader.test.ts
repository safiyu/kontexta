import { describe, it, expect } from "vitest";
import { loadExtraPatterns } from "../../src/journal/patterns/extra-loader.js";
import type { RawEvent } from "../../src/journal/types.js";

function ev(o: Partial<RawEvent>): RawEvent {
  return {
    ts: "2026-05-12T16:00:00Z",
    agent: "claude-code", sid: "s", event: "tool_call",
    tool: "update_file", args: {}, touched: [], status: "ok", ms: 10,
    ...o,
  };
}

describe("loadExtraPatterns", () => {
  it("returns empty array when input is null/undefined", () => {
    expect(loadExtraPatterns(undefined)).toEqual([]);
    expect(loadExtraPatterns(null as any)).toEqual([]);
  });

  it("compiles a pattern with tag_any + min_events match into a PatternDetector", () => {
    const detectors = loadExtraPatterns([
      { name: "compliance-audit", match: { tag_any: ["compliance", "audit"], min_events: 2 } },
    ]);
    expect(detectors.length).toBe(1);

    const events = [
      ev({ event: "agent_note", tags: ["compliance"], tool: undefined }),
      ev({ event: "agent_note", tags: ["audit"], tool: undefined }),
    ];
    const m = detectors[0].detect(events);
    expect(m).toBeDefined();
    expect(m!.name).toBe("compliance-audit");
    expect(m!.tags).toContain("compliance-audit");
  });

  it("returns null when min_events not met", () => {
    const detectors = loadExtraPatterns([
      { name: "x", match: { tag_any: ["foo"], min_events: 3 } },
    ]);
    const events = [
      ev({ event: "agent_note", tags: ["foo"], tool: undefined }),
      ev({ event: "agent_note", tags: ["foo"], tool: undefined }),
    ];
    expect(detectors[0].detect(events)).toBeNull();
  });

  it("rejects malformed entries with a warning, returns valid ones only", () => {
    const detectors = loadExtraPatterns([
      { name: "ok", match: { tag_any: ["x"], min_events: 1 } } as any,
      { match: {} } as any,
      { name: "no-match-clause" } as any,
    ]);
    expect(detectors.length).toBe(1);
    expect(detectors[0].name).toBe("ok");
  });
});
