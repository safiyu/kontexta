// packages/core/tests/journal/topic-detector.test.ts
import { describe, it, expect } from "vitest";
import { groupEventsIntoTasks, extractTicketId } from "../../src/journal/topic-detector.js";
import type { RawEvent, JournalFrontmatter } from "../../src/journal/types.js";

function ev(overrides: Partial<RawEvent> = {}): RawEvent {
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

const TICKET_RE = /[A-Z]+-\d+/;

describe("extractTicketId", () => {
  it("extracts JIRA-style IDs", () => {
    expect(extractTicketId("fix/INC-1234-websocket-drop", TICKET_RE)).toBe("INC-1234");
  });
  it("returns null when none", () => {
    expect(extractTicketId("main", TICKET_RE)).toBeNull();
  });
});

describe("groupEventsIntoTasks", () => {
  const minimalOpenTask = (): JournalFrontmatter => ({
    task: "existing-ws", project: "demo", tags: [],
    touched_files: ["packages/core/src/websocket.ts"],
    git: { branches: ["fix/INC-1234-websocket-drop"], commits: [], ticket_ids: ["INC-1234"] },
    status_latest: null,
    started_at: "2026-04-01T00:00Z",
    last_active_at: "2026-05-10T00:00Z",
    distilled_from: [],
  });

  it("buckets a tool_call by ticket match against an existing open task", () => {
    const events = [
      ev({ event: "git_context", branch: "fix/INC-1234-websocket-drop", tool: undefined }),
      ev({ touched: ["unrelated/path.ts"] }),
    ];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE);
    expect(buckets.find((b) => b.task_slug === "existing-ws")).toBeDefined();
    expect(buckets.find((b) => b.task_slug === "existing-ws")?.matched_via).toBe("ticket");
  });

  it("buckets by file overlap when no branch context exists", () => {
    const events = [ev({ touched: ["packages/core/src/websocket.ts"] })];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE);
    expect(buckets[0].task_slug).toBe("existing-ws");
    expect(buckets[0].matched_via).toBe("files");
  });

  it("mints a new slug from branch when no open task matches", () => {
    const events = [
      ev({ event: "git_context", branch: "feat/STORY-99-payments", tool: undefined }),
      ev({ touched: ["src/payments.ts"] }),
    ];
    const buckets = groupEventsIntoTasks(events, [], TICKET_RE);
    expect(buckets[0].task_slug).toBe("STORY-99");
    expect(buckets[0].is_new).toBe(true);
    expect(buckets[0].matched_via).toBe("minted");
  });

  it("orphans events with no branch and no touched files into 'orphan'", () => {
    const events = [ev({ touched: [] })];
    const buckets = groupEventsIntoTasks(events, [], TICKET_RE);
    expect(buckets[0].task_slug).toBe("orphan");
  });
});
