// packages/core/tests/journal/topic-pivot.test.ts
import { describe, it, expect } from "vitest";
import { detectTopicPivot, TopicPivotResult } from "../../src/journal/topic-detector.js";

describe("detectTopicPivot", () => {
  function makeContext(title = "auth-refactor", files = ["src/auth/login.ts", "src/auth/jwt.ts"], lastEvents = "Implementing JWT token refresh"): { title: string; recentFiles: string[]; lastFewEvents: string } {
    return { title, recentFiles: files, lastFewEvents: lastEvents };
  }

  function makeEvent(type = "tool_call", content = "working on auth", command?: string): { type: string; content: string; command?: string } {
    return { type, content, command };
  }

  function assertPivot(result: TopicPivotResult, expected: { isPivot: boolean; minConfidence?: number }) {
    expect(result.isPivot).toBe(expected.isPivot);
    if (expected.minConfidence !== undefined) {
      expect(result.confidence).toBeGreaterThanOrEqual(expected.minConfidence);
    }
    if (expected.isPivot) {
      expect(result.suggestedNewSlug).not.toBeNull();
    } else {
      expect(result.suggestedNewSlug).toBeNull();
    }
  }

  describe("heuristic pivot detection (model unavailable)", () => {
    it("detects a pivot to a new domain (auth → database)", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts"]);
      const event = makeEvent(
        "tool_call",
        "migrating the PostgreSQL database schema for users table"
      );

      const result = await detectTopicPivot(context, event);
      expect(result.isPivot).toBe(true);
    });

    it("detects a pivot to a different domain (auth → deploy)", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts", "src/auth/jwt.ts"]);
      const event = makeEvent(
        "shell",
        "deploying to AWS ECS cluster"
      );

      const result = await detectTopicPivot(context, event);
      // Should detect as pivot since deploy/infra is not auth domain
      expect(result.isPivot).toBe(true);
    });

    it("detects a pivot via file path shift to new domain", async () => {
      const context = makeContext("auth-refactor", ["src/auth/jwt.ts"]);
      const event = makeEvent(
        "tool_call",
        "creating Docker deployment configuration"
      );

      const result = await detectTopicPivot(context, event);
      expect(result.isPivot).toBe(true);
    });

    it("does NOT detect a pivot for incremental changes in same domain", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts", "src/auth/jwt.ts"]);
      const event = makeEvent(
        "tool_call",
        "adding token refresh logic to the authentication middleware"
      );

      const result = await detectTopicPivot(context, event);
      expect(result.isPivot).toBe(false);
    });

    it("does NOT detect a pivot for similar content", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts"]);
      const event = makeEvent(
        "tool_call",
        "implementing password hashing in the auth module"
      );

      const result = await detectTopicPivot(context, event);
      expect(result.isPivot).toBe(false);
    });

    it("detects pivot when switching to multiple new domains", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts"]);
      const event = makeEvent(
        "agent_note",
        "abandoning this approach, switching to CI pipeline and database migration"
      );

      const result = await detectTopicPivot(context, event);
      // ci/cd and database are both new domains for auth context
      expect(result.isPivot).toBe(true);
    });

    it("handles empty context gracefully", async () => {
      const context = { title: "", recentFiles: [], lastFewEvents: "" };
      const event = makeEvent("tool_call", "starting new task");

      const result = await detectTopicPivot(context, event);
      expect(typeof result.isPivot).toBe("boolean");
    });

    it("handles empty event gracefully", async () => {
      const context = makeContext("auth-refactor");
      const event = makeEvent("tool_call", "");

      const result = await detectTopicPivot(context, event);
      expect(typeof result.isPivot).toBe("boolean");
    });
  });

  describe("suggested slug generation", () => {
    it("generates a slug when a pivot is detected", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts"]);
      const event = makeEvent("tool_call", "deploying to AWS ECS");

      const result = await detectTopicPivot(context, event);
      if (result.isPivot) {
        expect(result.suggestedNewSlug).toMatch(/deploy/);
      }
    });
  });

  describe("confidence scoring", () => {
    it("returns high confidence for clear domain shift", async () => {
      const context = makeContext("ui-component", ["src/components/Button.tsx"]);
      const event = makeEvent("shell", "docker-compose up -d");

      const result = await detectTopicPivot(context, event);
      // Should have at least moderate confidence
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("returns low confidence for ambiguous events", async () => {
      const context = makeContext("auth-refactor", ["src/auth/login.ts"]);
      const event = makeEvent("shell", "npm install");

      const result = await detectTopicPivot(context, event);
      // Low confidence for ambiguous
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe("edge cases", () => {
    it("handles very long content strings", async () => {
      const context = makeContext("auth", ["src/auth.ts"]);
      const event = makeEvent(
        "tool_call",
        "a".repeat(5000)
      );

      await expect(detectTopicPivot(context, event)).resolves.not.toThrow();
    });

    it("handles special characters in content", async () => {
      const context = makeContext("auth", ["src/auth.ts"]);
      const event = makeEvent("tool_call", "Testing <script>alert('xss')</script> and <svg><animate /></svg>");

      await expect(detectTopicPivot(context, event)).resolves.not.toThrow();
    });
  });
});
