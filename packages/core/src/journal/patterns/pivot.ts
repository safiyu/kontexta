import type { PatternDetector } from "./index.js";

export const pivotDetector: PatternDetector = {
  name: "pivot",
  detect(events) {
    const intents = events.filter((e) => e.event === "user_intent");
    if (intents.length === 0) return null;
    return {
      name: "pivot",
      summary: `user pivots: ${intents.length} intent change(s) recorded`,
      details: intents.map((i) => `${i.ts.slice(11, 19)}: ${i.summary ?? "(no summary)"}`),
      tags: ["pivot", "user-intent"],
    };
  },
};
