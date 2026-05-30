import type { PatternDetector } from "./index.js";

const FEAT_BRANCH_RE = /^(feat\/|feature\/)/i;
const FEAT_COMMIT_RE = /^feat[(:\s]/i;

export const featureDevelopmentDetector: PatternDetector = {
  name: "feature-development",
  detect(events) {
    const ctx = events.find(
      (e) => e.event === "git_context" && FEAT_BRANCH_RE.test(e.branch ?? "")
    );
    const featCommits = events.filter(
      (e) => e.event === "git_commit" && FEAT_COMMIT_RE.test(e.msg ?? "")
    );
    if (!ctx && featCommits.length === 0) return null;

    return {
      name: "feature-development",
      summary: `feature development${ctx ? ` on ${ctx.branch}` : ""}: ${featCommits.length} feat commit(s)`,
      details: [
        ctx ? `branch: ${ctx.branch}` : "no branch context",
        `${featCommits.length} feat-tagged commit(s)`,
      ],
      tags: ["feature-development", "feature"],
    };
  },
};
