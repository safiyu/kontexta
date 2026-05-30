import type { PatternDetector } from "./index.js";

export const testCycleDetector: PatternDetector = {
  name: "test-cycle",
  detect(events) {
    const testEdits = events.filter(
      (e) => e.event === "tool_call" && e.tool?.startsWith("update_") &&
             (e.touched ?? []).some((f) => /\.(test|spec)\.[tj]sx?$/.test(f))
    );
    const testRuns = events.filter(
      (e) => e.event === "tool_call" && e.tool?.startsWith("hands") &&
             /test/i.test(JSON.stringify(e.args ?? {}))
    );
    if (testEdits.length === 0 || testRuns.length === 0) return null;
    const passed = testRuns.filter((e) => e.status === "ok").length;
    const failed = testRuns.length - passed;
    return {
      name: "test-cycle",
      summary: `test-driven cycle: ${testEdits.length} test edit(s) + ${testRuns.length} test run(s) (${passed} pass, ${failed} fail)`,
      details: [
        `${testEdits.length} edits to test files`,
        `${testRuns.length} test invocations: ${passed} passed, ${failed} failed`,
      ],
      tags: ["test-cycle", failed === 0 ? "tests-passing" : "tests-failing"],
    };
  },
};
