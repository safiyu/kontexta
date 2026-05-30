import { execFileSync } from "node:child_process";
import type { RawEvent } from "./types.js";

export interface GitWatcherState {
  branch: string | null;
  head: string | null;
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function checkGit(
  projectPath: string,
  state: GitWatcherState,
  meta: { agent?: string; sid?: string; project?: string } = {},
): Promise<RawEvent[]> {
  const branch = tryGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = tryGit(projectPath, ["rev-parse", "HEAD"]);
  if (branch === null || head === null) return [];

  const events: RawEvent[] = [];
  const now = new Date().toISOString();

  if (branch !== state.branch) {
    events.push({
      ts: now, agent: meta.agent ?? "unknown", sid: meta.sid ?? "unknown",
      event: "git_context", branch, head, project: meta.project,
    });
  }

  if (state.head !== null && head !== state.head) {
    const log = tryGit(projectPath, [
      "log", `${state.head}..${head}`, "--pretty=format:%H%x09%s",
    ]) ?? "";
    for (const line of log.split("\n").filter(Boolean).reverse()) {
      const [sha, msg] = line.split("\t");
      const filesOut = tryGit(projectPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
      const files_changed = filesOut ? filesOut.split("\n").filter(Boolean) : [];
      events.push({
        ts: now, agent: meta.agent ?? "unknown", sid: meta.sid ?? "unknown",
        event: "git_commit", sha, msg, files_changed, project: meta.project,
      });
    }
  }

  state.branch = branch;
  state.head = head;
  return events;
}
