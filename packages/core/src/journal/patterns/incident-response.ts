import type { PatternDetector } from "./index.js";

const INCIDENT_BRANCH_RE = /^(fix\/INC-|hotfix\/|incident\/)/i;

export const incidentResponseDetector: PatternDetector = {
  name: "incident-response",
  detect(events) {
    const ctxs = events.filter(
      (e) => e.event === "git_context" && INCIDENT_BRANCH_RE.test(e.branch ?? "")
    );
    if (ctxs.length === 0) return null;

    const errors = events.filter((e) => e.event === "error");
    const branch = ctxs[0].branch!;
    return {
      name: "incident-response",
      summary: `incident response on branch ${branch}: ${errors.length} error(s) handled`,
      details: [
        `branch: ${branch}`,
        `${errors.length} error event(s) in window`,
      ],
      tags: ["incident-response", "incident"],
    };
  },
};
