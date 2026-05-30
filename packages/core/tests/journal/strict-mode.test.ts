// packages/core/tests/journal/strict-mode.test.ts
import { describe, it, expect } from "vitest";
import { isReadOnlyTool, shouldBlock } from "../../src/journal/strict-mode.js";

describe("strict-mode", () => {
  it("classifies read-only tools correctly", () => {
    expect(isReadOnlyTool("search")).toBe(true);
    expect(isReadOnlyTool("read_files")).toBe(true);
    expect(isReadOnlyTool("update_file")).toBe(false);
    expect(isReadOnlyTool("journal_note")).toBe(false);
    expect(isReadOnlyTool("distill_journal")).toBe(false);
  });

  it("blocks read tools when backlog exists and mode=strict", () => {
    expect(shouldBlock("strict", "search", { backlog_events: 5 }, false)).toBe(true);
    expect(shouldBlock("strict", "search", { backlog_events: 0 }, false)).toBe(false);
    expect(shouldBlock("strict", "update_file", { backlog_events: 5 }, false)).toBe(false);
  });

  it("does not block when bypass is true", () => {
    expect(shouldBlock("strict", "search", { backlog_events: 5 }, true)).toBe(false);
  });

  it("never blocks in lenient mode", () => {
    expect(shouldBlock("lenient", "search", { backlog_events: 999 }, false)).toBe(false);
  });
});
