import type { PatternDetector } from "./index.js";

export const errorRecoveryDetector: PatternDetector = {
  name: "error-recovery-cycle",
  detect(events) {
    const errs = events.filter((e) => e.event === "error");
    if (errs.length === 0) return null;

    const errorFiles = new Set<string>();
    for (const e of errs) for (const f of e.touched ?? []) errorFiles.add(f);

    const lastError = errs[errs.length - 1];
    const lastErrorIdx = events.lastIndexOf(lastError);
    const afterLastError = events.slice(lastErrorIdx + 1);
    const recoveryEdits = afterLastError.filter(
      (e) => e.event === "tool_call" && e.status === "ok" &&
             (e.touched ?? []).some((f) => errorFiles.has(f))
    );
    const followUpErrors = afterLastError.filter((e) => e.event === "error");

    const resolved = recoveryEdits.length > 0 && followUpErrors.length === 0;
    const filesList = [...errorFiles].join(", ") || "(unknown)";

    return {
      name: "error-recovery-cycle",
      summary: `error-recovery cycle on ${filesList}${resolved ? " (resolved)" : " (unresolved)"}`,
      details: [
        `${errs.length} error event(s) on ${filesList}`,
        `${recoveryEdits.length} recovery edit(s) after last error`,
        resolved ? "no further errors observed" : "errors continued or no recovery edits",
      ],
      tags: ["error-recovery", resolved ? "resolved" : "unresolved"],
    };
  },
};
