// packages/core/tests/journal/event-triage.test.ts
import { describe, it, expect } from "vitest";
import { triageEvent } from "../../src/journal/event-triage.js";
import type { TriageResult } from "../../src/journal/event-triage.js";

describe("triageEvent", () => {
  it("grades noise-level events (grade 0) for git status commands", async () => {
    const result = await triageEvent({ type: "shell", command: "git status" });
    expect(result.grade).toBe(0);
    expect(result.score).toBe(0);
  });

  it("grades noise-level events (grade 0) for ls commands", async () => {
    const result = await triageEvent({ type: "shell", command: "ls" });
    expect(result.grade).toBe(0);
    expect(result.score).toBe(0);
  });

  it("grades noise-level events (grade 0) for pwd command", async () => {
    const result = await triageEvent({ type: "shell", command: "pwd" });
    expect(result.grade).toBe(0);
    expect(result.score).toBe(0);
  });

  it("grades noise-level events (grade 0) for ls -la command", async () => {
    const result = await triageEvent({ type: "shell", command: "ls -la" });
    expect(result.grade).toBe(0);
    expect(result.score).toBe(0);
  });

  it("grades noise-level events (grade 0) for echo command", async () => {
    const result = await triageEvent({ type: "shell", command: "echo hello" });
    expect(result.grade).toBe(0);
    expect(result.score).toBe(0);
  });

  it("grades routine events (grade 1) for file edits", async () => {
    const result = await triageEvent({ type: "tool_call", content: "file edit on config.ts" });
    expect(result.grade).toBe(1);
    expect(result.score).toBe(1);
  });

  it("grades routine events (grade 1) for build/compile commands", async () => {
    const result = await triageEvent({ type: "shell", command: "npm run build" });
    expect(result.grade).toBe(1);
    expect(result.score).toBe(1);
  });

  it("grades routine events (grade 1) for lint commands", async () => {
    const result = await triageEvent({ type: "shell", command: "npm run lint" });
    expect(result.grade).toBe(1);
    expect(result.score).toBe(1);
  });

  it("grades routine events (grade 1) for dependency operations", async () => {
    const result = await triageEvent({ type: "shell", command: "npm install express" });
    // npm install matches the grade 2 dependency-install pattern (context shift)
    expect(result.grade).toBe(2);
    expect(result.score).toBe(2);
  });

  it("grades context shifts (grade 2) for branch changes", async () => {
    const result = await triageEvent({ type: "shell", command: "git checkout main" });
    expect(result.grade).toBe(2);
    expect(result.score).toBe(2);
  });

  it("grades context shifts (grade 2) for environment updates", async () => {
    const result = await triageEvent({ type: "shell", command: "export ENV=production" });
    expect(result.grade).toBe(2);
    expect(result.score).toBe(2);
  });

  it("grades context shifts (grade 2) for config changes", async () => {
    const result = await triageEvent({ type: "shell", command: "config update database_url" });
    expect(result.grade).toBe(2);
    expect(result.score).toBe(2);
  });

  it("grades context shifts (grade 2) for dependency installs", async () => {
    const result = await triageEvent({ type: "shell", command: "yarn add lodash" });
    expect(result.grade).toBe(2);
    expect(result.score).toBe(2);
  });

  it("grades context shifts (grade 2) for venv/poetry operations", async () => {
    const result = await triageEvent({ type: "shell", command: "poetry add requests" });
    expect(result.grade).toBe(2);
    expect(result.score).toBe(2);
  });

  it("grades high signal events (grade 3) for errors", async () => {
    const result = await triageEvent({ type: "error", content: "TypeError: Cannot read property of undefined" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("grades high signal events (grade 3) for exceptions", async () => {
    const result = await triageEvent({ type: "error", content: "UnhandledPromiseRejectionWarning" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("grades high signal events (grade 3) for test failures", async () => {
    const result = await triageEvent({ type: "tool_call", content: "test failed: assertionError in auth test" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("grades high signal events (grade 3) for stack traces", async () => {
    const result = await triageEvent({ type: "error", content: "stack trace at line 42" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("grades high signal events (grade 3) for panics and crashes", async () => {
    const result = await triageEvent({ type: "error", content: "panic: runtime error" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("grades high signal events (grade 3) for assert failures", async () => {
    const result = await triageEvent({ type: "tool_call", content: "assert failed: expected true but got false" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("grades critical pivots (grade 4) for abandonment", async () => {
    const result = await triageEvent({ type: "agent_note", content: "abandoning this approach entirely" });
    expect(result.grade).toBe(4);
    expect(result.score).toBe(4);
  });

  it("grades critical pivots (grade 4) for rearchitect decisions", async () => {
    const result = await triageEvent({ type: "agent_note", content: "deciding to rearchitect the module" });
    expect(result.grade).toBe(4);
    expect(result.score).toBe(4);
  });

  it("grades critical pivots (grade 4) for migration plans", async () => {
    const result = await triageEvent({ type: "agent_note", content: "creating a migration plan for the database" });
    expect(result.grade).toBe(4);
    expect(result.score).toBe(4);
  });

  it("grades critical pivots (grade 4) for deprecation decisions", async () => {
    const result = await triageEvent({ type: "agent_note", content: "deprecating the entire legacy API" });
    expect(result.grade).toBe(4);
    expect(result.score).toBe(4);
  });

  it("returns default grade for unrecognized events", async () => {
    const result = await triageEvent({ type: "unknown", content: "something vague" });
    // Should fall to default grade 1 (low-signal)
    expect(result.grade).toBe(1);
    expect(result.score).toBe(0.5);
  });

  it("handles empty event gracefully", async () => {
    const result = await triageEvent({});
    // Should return default
    expect(result.grade).toBe(1);
    expect(result.score).toBe(0.5);
  });

  it("handles only command field", async () => {
    const result = await triageEvent({ command: "grep pattern file.txt" });
    expect(result.grade).toBe(0);
    expect(result.score).toBe(0);
  });

  it("handles only content field", async () => {
    const result = await triageEvent({ content: "this is an error message" });
    expect(result.grade).toBe(3);
    expect(result.score).toBe(3);
  });

  it("priority ordering: error detection beats context shift detection", async () => {
    const result = await triageEvent({ type: "error", content: "error in branch checkout" });
    // Should be grade 3 (error) not grade 2 (context shift)
    expect(result.grade).toBe(3);
  });

  it("critical pivot detection beats error detection", async () => {
    const result = await triageEvent({ type: "agent_note", content: "error detected, abandoning approach entirely" });
    // Should be grade 4 (critical) since abandon matches before error
    expect(result.grade).toBe(4);
  });
});
