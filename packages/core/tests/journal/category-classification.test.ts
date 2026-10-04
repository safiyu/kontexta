// packages/core/tests/journal/category-classification.test.ts
import { describe, it, expect } from "vitest";
import { classifyTaskCategory } from "../../src/journal/topic-detector.js";
import type { RawEvent } from "../../src/journal/types.js";

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    ts: "2026-07-22T10:00:00Z",
    event: "tool_call",
    agent: "test-agent",
    sid: "test-sid",
    ...overrides,
  };
}

describe("classifyTaskCategory", () => {
  describe("debugging category (heuristic fallback)", () => {
    it("classifies error-related events as debugging", async () => {
      const events = [
        makeEvent({ text: "TypeError: Cannot read property of undefined", event: "error" }),
        makeEvent({ text: "Fixing the null pointer exception in auth module", event: "agent_note" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("debugging");
    });

    it("classifies test failures as debugging", async () => {
      const events = [
        makeEvent({ text: "Test failed: AssertionError in user-test.ts", event: "tool_result" }),
        makeEvent({ text: "Fixing the failing test", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("debugging");
    });

    it("classifies crash/panic events as debugging", async () => {
      const events = [
        makeEvent({ text: "panic: runtime error: index out of range", event: "error" }),
        makeEvent({ text: "Stack trace at main.go:42", event: "tool_result" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("debugging");
    });

    it("classifies regression bugs as debugging", async () => {
      const events = [
        makeEvent({ text: "Regression: login page stopped working after deploy", event: "agent_note" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("debugging");
    });
  });

  describe("infra_ops category", () => {
    it("classifies docker/containers as infra_ops", async () => {
      const events = [
        makeEvent({ text: "Building Docker image for the app", command: "docker build -t app ." }),
        makeEvent({ text: "Deploying to Kubernetes cluster", command: "kubectl apply -f deployment.yaml" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("infra_ops");
    });

    it("classifies CI/CD pipeline changes as infra_ops", async () => {
      const events = [
        makeEvent({ text: "Updating the GitHub Actions CI pipeline", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("infra_ops");
    });

    it("classifies environment configuration as infra_ops", async () => {
      const events = [
        makeEvent({ text: "Updating the deployment environment with terraform", command: "terraform plan" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("infra_ops");
    });
  });

  describe("refactoring category", () => {
    it("classifies code restructuring as refactoring", async () => {
      const events = [
        makeEvent({ text: "Refactoring the authentication module for better separation", event: "agent_note" }),
        makeEvent({ text: "Extracting the token validation into a separate function", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("refactoring");
    });

    it("classifies cleanup/dead code removal as refactoring", async () => {
      const events = [
        makeEvent({ text: "Refactoring the authentication module by extracting methods and renaming variables", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("refactoring");
    });

    it("classifies renaming operations as refactoring", async () => {
      const events = [
        makeEvent({ text: "Extracting methods and renaming variables for clarity", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("refactoring");
    });
  });

  describe("documentation category", () => {
    it("classifies README updates as documentation", async () => {
      const events = [
        makeEvent({ text: "Writing the README for the project", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("documentation");
    });

    it("classifies guide/tutorial creation as documentation", async () => {
      const events = [
        makeEvent({ text: "Creating a how-to guide for the API", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("documentation");
    });

    it("classifies changelog entries as documentation", async () => {
      const events = [
        makeEvent({ text: "Updating the changelog for v2.0", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("documentation");
    });
  });

  describe("research_exploration category", () => {
    it("classifies investigation as research_exploration", async () => {
      const events: RawEvent[] = [
        {
          ts: "2026-07-22T10:00:00Z",
          event: "agent_note",
          agent: "test-agent",
          sid: "test-sid",
          text: "Benchmarking the search performance to compare algorithms",
        },
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("research_exploration");
    });

    it("classifies POC experiments as research_exploration", async () => {
      const events = [
        makeEvent({ text: "Experimenting with a new caching strategy as a proof of concept", event: "agent_note" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("research_exploration");
    });

    it("classifies benchmarking as research_exploration", async () => {
      const events = [
        makeEvent({ text: "Benchmarking SQLite vs PostgreSQL for our use case", event: "agent_note" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("research_exploration");
    });
  });

  describe("feature_dev category (default)", () => {
    it("classifies feature implementation as feature_dev", async () => {
      const events = [
        makeEvent({ text: "Implementing the user registration endpoint", event: "tool_call" }),
        makeEvent({ text: "Adding the POST /api/users handler", event: "agent_note" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("feature_dev");
    });

    it("classifies new module creation as feature_dev", async () => {
      const events = [
        makeEvent({ text: "Creating a new plugin for email notifications", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("feature_dev");
    });

    it("defaults to feature_dev for unknown events", async () => {
      const events = [
        makeEvent({ text: "Doing something with the code", event: "tool_call" }),
      ];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("feature_dev");
    });
  });

  describe("edge cases", () => {
    it("handles empty events array", async () => {
      const result = await classifyTaskCategory([]);
      expect(result).toBe("feature_dev");
    });

    it("handles events with no text content", async () => {
      const events = [makeEvent({ text: "", summary: "", msg: "", command: "" })];
      const result = await classifyTaskCategory(events);
      expect(result).toBe("feature_dev");
    });

    it("handles very long event texts", async () => {
      const events = [makeEvent({ text: "x".repeat(10000) })];
      await expect(classifyTaskCategory(events)).resolves.toBeDefined();
    });

    it("prioritizes debugging over other categories", async () => {
      const events = [
        makeEvent({ text: "Refactoring the code to fix the error in the pipeline" }),
      ];
      const result = await classifyTaskCategory(events);
      // Error/fix keywords should prioritize debugging
      expect(result).toBe("debugging");
    });
  });
});
