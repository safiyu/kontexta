import type { PatternDetector } from "./index.js";

const BUILD_PATTERN = /build|compile|tsc|webpack|next/i;

function isBuildEvent(e: { tool?: string; args?: Record<string, unknown> }): boolean {
  if (!e.tool || !e.tool.startsWith("hands")) return false;
  return BUILD_PATTERN.test(JSON.stringify(e.args ?? {}));
}

export const buildFailureRecoveryDetector: PatternDetector = {
  name: "build-failure-recovery",
  detect(events) {
    const buildRuns = events.filter(isBuildEvent);
    if (buildRuns.length < 2) return null;
    const failedFirst = buildRuns.find((e) => e.status === "error");
    const passedLater = buildRuns.find(
      (e, i) => i > buildRuns.indexOf(failedFirst!) && e.status === "ok"
    );
    if (!failedFirst || !passedLater) return null;
    const editsBetween = events.filter(
      (e) =>
        e.ts > failedFirst.ts && e.ts < passedLater.ts &&
        e.event === "tool_call" && e.tool?.startsWith("update_")
    );
    return {
      name: "build-failure-recovery",
      summary: `build broke and was fixed via ${editsBetween.length} edit(s)`,
      details: [
        `first failed build at ${failedFirst.ts}`,
        `${editsBetween.length} edits before recovery`,
        `recovery confirmed at ${passedLater.ts}`,
      ],
      tags: ["build-failure-recovery", "resolved"],
    };
  },
};
