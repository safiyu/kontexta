// packages/core/tests/journal/topic-detector.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyTaskCategory,
  groupEventsIntoTasks,
  extractTicketId,
} from "../../src/journal/topic-detector.js";
import type { RawEvent, JournalFrontmatter } from "../../src/journal/types.js";

describe("extractTicketId", () => {
  it("extracts ticket ID from branch name", () => {
    const result = extractTicketId("feat/KONT-123-add-auth", /[A-Z]+-\d+/);
    expect(result).toBe("KONT-123");
  });

  it("returns null for branch without ticket ID", () => {
    const result = extractTicketId("feature/new-ui", /[A-Z]+-\d+/);
    expect(result).toBeNull();
  });

  it("handles branch with multiple ticket-like patterns", () => {
    const result = extractTicketId("fix/ABC-42-fix-bug", /[A-Z]+-\d+/);
    expect(result).toBe("ABC-42");
  });
});

describe("classifyTaskCategory", () => {
  it("classifies debugging category for error-heavy events", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "error", msg: "TypeError: Cannot read property" },
      { ts: "2026-01-01T00:00:01Z", agent: "claude-code", sid: "s1", event: "agent_note", summary: "fixing the null pointer exception" },
    ];
    const result = await classifyTaskCategory(events);
    expect(result).toBe("debugging");
  });

  it("classifies refactoring category for cleanup events", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "user_prompt", text: "refactor the entire auth module" },
      { ts: "2026-01-01T00:00:01Z", agent: "claude-code", sid: "s1", event: "agent_note", summary: "renaming functions for clarity" },
    ];
    const result = await classifyTaskCategory(events);
    expect(result).toBe("refactoring");
  });

  it("classifies infra_ops for deployment events", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "shell", command: "docker build -t app ." },
      { ts: "2026-01-01T00:00:01Z", agent: "claude-code", sid: "s1", event: "agent_note", summary: "deploying to kubernetes" },
    ];
    const result = await classifyTaskCategory(events);
    expect(result).toBe("infra_ops");
  });

  it("classifies documentation for docs events", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "user_prompt", text: "write the README for this module" },
      { ts: "2026-01-01T00:00:01Z", agent: "claude-code", sid: "s1", event: "tool_call", tool: "files.write", args: { path: "README.md" } },
    ];
    const result = await classifyTaskCategory(events);
    expect(result).toBe("documentation");
  });

  it("classifies research_exploration for investigation events", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "user_prompt", text: "explore different caching strategies" },
      { ts: "2026-01-01T00:00:01Z", agent: "claude-code", sid: "s1", event: "agent_note", summary: "comparing redis vs memcached" },
    ];
    const result = await classifyTaskCategory(events);
    expect(result).toBe("research_exploration");
  });

  it("classifies feature_dev for implementation events", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "user_prompt", text: "implement a new REST endpoint" },
      { ts: "2026-01-01T00:00:01Z", agent: "claude-code", sid: "s1", event: "tool_call", tool: "files.write", args: { path: "api/users.ts" } },
    ];
    const result = await classifyTaskCategory(events);
    expect(result).toBe("feature_dev");
  });

  it("returns feature_dev as default for empty events", async () => {
    const result = await classifyTaskCategory([]);
    expect(result).toBe("feature_dev");
  });

  it("handles events with only ts and sid", async () => {
    const events: RawEvent[] = [
      { ts: "2026-01-01T00:00:00Z", agent: "claude-code", sid: "s1", event: "shell", command: "git status" },
    ];
    const result = await classifyTaskCategory(events);
    // "git status" doesn't match any specific category, falls through to feature_dev
    expect(result).toBe("feature_dev");
  });
});

describe("groupEventsIntoTasks", () => {
  function makeEvent(overrides: Partial<RawEvent>): RawEvent {
    return {
      ts: "2026-01-01T00:00:00Z",
      agent: "claude-code",
      sid: "s1",
      event: "user_prompt",
      ...overrides,
    };
  }

  it("groups events without branch into adhoc tasks", () => {
    const events = [
      makeEvent({ ts: "2026-01-01T00:00:00Z", event: "user_prompt", text: "fix the login bug" }),
      makeEvent({ ts: "2026-01-01T00:00:01Z", event: "tool_call", tool: "files.write" }),
    ];
    const openTasks: JournalFrontmatter[] = [];
    const result = groupEventsIntoTasks(events, openTasks, /[A-Z]+-\d+/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("assigns events to tasks by branch match", () => {
    const events = [
      makeEvent({ ts: "2026-01-01T00:00:00Z", event: "git_context", branch: "feat/KONT-123-auth" }),
      makeEvent({ ts: "2026-01-01T00:00:01Z", event: "user_prompt", text: "implement auth" }),
    ];
    const openTasks: JournalFrontmatter[] = [
      {
        task: "KONT-123-auth",
        project: "test",
        tags: [],
        touched_files: [],
        git: { branches: ["feat/KONT-123-auth"], commits: [], ticket_ids: ["KONT-123"] },
        status_latest: null,
        started_at: "2026-01-01T00:00:00Z",
        last_active_at: "2026-01-01T00:00:00Z",
        distilled_from: [],
      },
    ];
    const result = groupEventsIntoTasks(events, openTasks, /[A-Z]+-\d+/);
    expect(result.some((b) => b.task_slug === "KONT-123-auth")).toBe(true);
  });

  it("creates separate buckets for events on different branches", () => {
    const events = [
      makeEvent({ ts: "2026-01-01T00:00:00Z", event: "git_context", branch: "feat/branch-a" }),
      makeEvent({ ts: "2026-01-01T00:00:01Z", event: "user_prompt", text: "work on branch a" }),
      makeEvent({ ts: "2026-01-01T00:00:02Z", event: "git_context", branch: "feat/branch-b" }),
      makeEvent({ ts: "2026-01-01T00:00:03Z", event: "user_prompt", text: "work on branch b" }),
    ];
    const openTasks: JournalFrontmatter[] = [];
    const result = groupEventsIntoTasks(events, openTasks, /[A-Z]+-\d+/);
    const slugs = result.map((b) => b.task_slug);
    // Should have two separate buckets
    expect(slugs.some((s) => s.includes("branch-a"))).toBe(true);
    expect(slugs.some((s) => s.includes("branch-b"))).toBe(true);
  });
});
