import { describe, it, expect } from "vitest";
import { AGENTS } from "../../src/hooks/agents.js";
import { SCAFFOLDS } from "../../src/agent-rules/index.js";

describe("AGENTS.onboardable", () => {
  it("is true exactly for agents that have a rules-file scaffold", () => {
    const onboardable = AGENTS.filter((a) => a.onboardable).map((a) => a.id).sort();
    expect(onboardable).toEqual(Object.keys(SCAFFOLDS).sort());
  });
});
