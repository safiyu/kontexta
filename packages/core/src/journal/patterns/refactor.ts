import type { PatternDetector } from "./index.js";

const REFACTOR_COMMIT_RE = /^refactor[(:\s]/i;

function commonDirectoryPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const segs = paths[0].split("/");
  let n = segs.length;
  for (const p of paths) {
    const ps = p.split("/");
    let i = 0;
    while (i < n && i < ps.length && ps[i] === segs[i]) i++;
    n = i;
  }
  return segs.slice(0, n).join("/");
}

export const refactorDetector: PatternDetector = {
  name: "refactor",
  detect(events) {
    const moves = events.filter(
      (e) => e.event === "tool_call" && e.tool === "move_file"
    );
    const updates = events.filter(
      (e) => e.event === "tool_call" && (e.tool ?? "").startsWith("update_")
    );
    const refactorCommits = events.filter(
      (e) => e.event === "git_commit" && REFACTOR_COMMIT_RE.test(e.msg ?? "")
    );

    if (moves.length < 2 && refactorCommits.length === 0) return null;
    if (moves.length + updates.length < 4) return null;

    const allPaths = [...moves, ...updates].flatMap((e) => e.touched ?? []);
    const prefix = commonDirectoryPrefix(allPaths);

    return {
      name: "refactor",
      summary: `refactor pass${prefix ? ` under ${prefix}/` : ""}: ${moves.length} move(s), ${updates.length} edit(s)`,
      details: [
        `${moves.length} file moves`,
        `${updates.length} file edits`,
        refactorCommits.length > 0
          ? `${refactorCommits.length} refactor-tagged commit(s)`
          : "no refactor-tagged commit observed",
      ],
      tags: ["refactor", refactorCommits.length > 0 ? "committed" : "in-progress"],
    };
  },
};
