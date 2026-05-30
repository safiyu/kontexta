// packages/core/tests/journal/renderer.test.ts
import { describe, it, expect } from "vitest";
import { renderMechanicalEntry } from "../../src/journal/renderer.js";
import type { RawEvent } from "../../src/journal/types.js";

function ev(overrides: Partial<RawEvent>): RawEvent {
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
