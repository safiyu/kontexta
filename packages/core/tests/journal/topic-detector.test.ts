// packages/core/tests/journal/topic-detector.test.ts
import { describe, it, expect } from "vitest";
import { groupEventsIntoTasks, groupEvents, extractTicketId } from "../../src/journal/topic-detector.js";
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

  it("names events with no branch, files or session id by time and agent instead of 'orphan'", () => {
    const events = [ev({ touched: [], sid: "unknown" })];
    const buckets = groupEventsIntoTasks(events, [], TICKET_RE);
    expect(buckets[0].task_slug).toBe("1600-claude-code");
  });

  it("uses a hook event's branch like a preceding git_context", () => {
    const events = [
      ev({ event: "user_prompt", tool: undefined, source: "hook", branch: "fix/INC-1234-websocket-drop", touched: undefined }),
      ev({ event: "shell", tool: undefined, source: "hook", branch: "fix/INC-1234-websocket-drop", touched: undefined }),
    ];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].task_slug).toBe("existing-ws");
    expect(buckets[0].matched_via).toBe("ticket");
  });

  it("mints a slug from a hook branch when no task matches", () => {
    const events = [ev({ event: "user_prompt", tool: undefined, source: "hook", branch: "feat/hooks", touched: undefined })];
    const buckets = groupEventsIntoTasks(events, [], TICKET_RE);
    expect(buckets[0].task_slug).toBe("hooks");
  });

  it("starts from initialBranch when no git_context has been seen in this batch", () => {
    const events = [ev({ event: "agent_note", tool: undefined, summary: "n", touched: undefined })];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE, { initialBranch: "fix/INC-1234-websocket-drop" });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ task_slug: "existing-ws", matched_via: "ticket" });
  });

  it("records the branch on the bucket even though git_context events are not bucketed", () => {
    const events = [ev({ event: "git_context", branch: "feat/new-thing", tool: undefined }), ev({ tool: "files.update", touched: ["a.ts"] })];
    const buckets = groupEventsIntoTasks(events, [], TICKET_RE);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].task_slug).toBe("new-thing");
    expect(buckets[0].branches).toEqual(["feat/new-thing"]);
  });

  it("hook events without a branch do not inherit the carried branch", () => {
    const events = [ev({ event: "user_prompt", source: "hook", sid: "claude-code:h1", tool: undefined, touched: undefined })];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE, { initialBranch: "fix/INC-1234-websocket-drop" });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].task_slug).toBe("1600-claude-code");
  });

  it("keeps the events of one session together via session affinity", () => {
    const events = [
      ev({ sid: "s1", touched: ["packages/core/src/websocket.ts"] }),
      ev({ sid: "s1", event: "agent_note", tool: undefined, summary: "x", touched: undefined }),
      ev({ sid: "s1", touched: ["unrelated/other.ts"] }),
    ];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].task_slug).toBe("existing-ws");
    expect(buckets[0].events).toHaveLength(3);
  });

  it("names branchless, fileless sessions by time and the session's first prompt or note", () => {
    const events = [
      ev({ ts: "2026-09-28T07:37:22.000Z", sid: "claude-code:aaa", agent: "claude-code", event: "user_prompt", source: "hook", tool: undefined, touched: undefined, text: "Why does CDC bootstrap wedge after a crash?" }),
      ev({ ts: "2026-09-28T07:40:00.000Z", sid: "gemini:bbb", agent: "gemini", event: "agent_note", tool: undefined, touched: undefined, summary: "Mapped the SLT run mail" }),
      ev({ ts: "2026-09-28T07:41:00.000Z", sid: "codex:ccc", agent: "codex", touched: [] }),
    ];
    expect(groupEventsIntoTasks(events, [], TICKET_RE).map((b) => b.task_slug)).toEqual([
      "0737-why-does-cdc-bootstrap-wedge-after",
      "0740-mapped-the-slt-run-mail",
      "0741-codex",
    ]);
  });

  it("disambiguates sessions that would get the same name", () => {
    const events = [ev({ sid: "a:1", agent: "codex", touched: [] }), ev({ sid: "a:2", agent: "codex", touched: [] })];
    expect(groupEventsIntoTasks(events, [], TICKET_RE).map((b) => b.task_slug)).toEqual(["1600-codex", "1600-codex-2"]);
  });

  it("takes the name from the session's first note even when that note lands in a branch task", () => {
    const events = [
      ev({ ts: "2026-09-28T07:37:00.000Z", sid: "s1", touched: [] }),
      ev({ ts: "2026-09-28T07:38:00.000Z", event: "git_context", branch: "feat/thing", tool: undefined, sid: "s1" }),
      ev({ ts: "2026-09-28T07:39:00.000Z", sid: "s1", event: "agent_note", tool: undefined, touched: undefined, summary: "Realtime stocks POC plan written" }),
    ];
    expect(groupEventsIntoTasks(events, [], TICKET_RE).map((b) => b.task_slug).sort()).toEqual(["0737-realtime-stocks-poc-plan-written", "thing"]);
  });

  it("reuses the name a session got in an earlier run and reports the sessions it placed", () => {
    const events = [ev({ sid: "s1", event: "agent_note", tool: undefined, touched: undefined, summary: "anything" })];
    const res = groupEvents(events, [], TICKET_RE, { initialSessions: { s1: "0737-old-name" } });
    expect(res.buckets.map((b) => b.task_slug)).toEqual(["0737-old-name"]);
    expect(res.sessions).toEqual({ s1: "0737-old-name" });

    const fresh = groupEvents([ev({ sid: "s2", agent: "codex", touched: [] })], [], TICKET_RE);
    expect(fresh.sessions).toEqual({ s2: "1600-codex" });
  });

  it("a different branch does not merge into another task", () => {
    const events = [ev({ event: "git_context", branch: "feat/other-thing", tool: undefined }), ev({ touched: [] })];
    const buckets = groupEventsIntoTasks(events, [minimalOpenTask()], TICKET_RE);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].task_slug).toBe("other-thing");
  });
});
