// packages/core/tests/decision/intent-router.test.ts
import { describe, it, expect } from "vitest";
import { routeQueryIntent } from "../../src/decision/intent-router.js";

describe("routeQueryIntent", () => {
  describe("heuristic classification (model unavailable)", () => {
    it("detects spec_authoritative intent for architectural queries", async () => {
      const result = await routeQueryIntent("What is the database schema architecture?");
      expect(result.intent).toBe("spec_authoritative");
      expect(result.dictionary_boost).toBe(0.15);
    });

    it("detects spec_authoritative intent for design docs", async () => {
      const result = await routeQueryIntent("Tell me about the design document for auth");
      expect(result.intent).toBe("spec_authoritative");
      expect(result.dictionary_boost).toBe(0.15);
    });

    it("detects spec_authoritative intent for API contracts", async () => {
      const result = await routeQueryIntent("What's the API contract for this endpoint?");
      expect(result.intent).toBe("spec_authoritative");
      expect(result.dictionary_boost).toBe(0.15);
    });

    it("detects troubleshooting_incident intent for error queries", async () => {
      const result = await routeQueryIntent("How do I fix the timeout error?");
      expect(result.intent).toBe("troubleshooting_incident");
      expect(result.dictionary_boost).toBe(-0.05);
    });

    it("detects troubleshooting_incident intent for bug reports", async () => {
      const result = await routeQueryIntent("There's a crash in the production logs");
      expect(result.intent).toBe("troubleshooting_incident");
      expect(result.dictionary_boost).toBe(-0.05);
    });

    it("detects troubleshooting_incident intent for debug queries", async () => {
      const result = await routeQueryIntent("Debug the exception in the payment flow");
      expect(result.intent).toBe("troubleshooting_incident");
      expect(result.dictionary_boost).toBe(-0.05);
    });

    it("detects code_symbol intent for camelCase identifiers", async () => {
      const result = await routeQueryIntent("Where is the getUserProfile function defined?");
      expect(result.intent).toBe("code_symbol");
      expect(result.dictionary_boost).toBe(0.0);
    });

    it("detects code_symbol intent for snake_case identifiers", async () => {
      const result = await routeQueryIntent("What does database_connection_pool do?");
      expect(result.intent).toBe("code_symbol");
      expect(result.dictionary_boost).toBe(0.0);
    });

    it("detects code_symbol intent for PascalCase identifiers", async () => {
      const result = await routeQueryIntent("How is the UserProfile component structured?");
      expect(result.intent).toBe("code_symbol");
      expect(result.dictionary_boost).toBe(0.0);
    });

    it("defaults to general_exploration for unrecognized queries", async () => {
      const result = await routeQueryIntent("Tell me about the project");
      expect(result.intent).toBe("general_exploration");
      expect(result.dictionary_boost).toBe(0.08);
    });

    it("handles empty query", async () => {
      const result = await routeQueryIntent("");
      expect(result.intent).toBe("general_exploration");
      expect(result.dictionary_boost).toBe(0.08);
    });

    it("handles whitespace-only query", async () => {
      const result = await routeQueryIntent("   ");
      expect(result.intent).toBe("general_exploration");
      expect(result.dictionary_boost).toBe(0.08);
    });
  });

  describe("keyword priority", () => {
    it("code_symbol pattern takes priority over keyword matching", async () => {
      // "getUserProfile" is camelCase, should match code_symbol even if "error" is present
      const result = await routeQueryIntent("The getUserProfile function is throwing an error");
      // camelCase should match first
      expect(result.intent).toBe("code_symbol");
    });

    it("error keyword takes precedence when no code symbols present", async () => {
      const result = await routeQueryIntent("There is an error in the code");
      expect(result.intent).toBe("troubleshooting_incident");
    });
  });

  describe("dictionary boost values", () => {
    it("spec_authoritative has highest positive boost", async () => {
      const result = await routeQueryIntent("What is the spec?");
      expect(result.dictionary_boost).toBe(0.15);
    });

    it("troubleshooting_incident has negative boost", async () => {
      const result = await routeQueryIntent("Error in the system");
      expect(result.dictionary_boost).toBe(-0.05);
    });

    it("code_symbol has zero boost", async () => {
      const result = await routeQueryIntent("What does myVariable do?");
      expect(result.dictionary_boost).toBe(0.0);
    });

    it("general_exploration has default boost", async () => {
      const result = await routeQueryIntent("Something random");
      expect(result.dictionary_boost).toBe(0.08);
    });
  });
});
