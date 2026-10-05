// packages/core/src/journal/topic-detector.ts
import type { RawEvent, TaskBucket, JournalFrontmatter } from "./types.js";
import { decisionEngine } from "../decision/engine.js";

export function extractTicketId(branch: string, ticketRegex: RegExp): string | null {
  const m = branch.match(ticketRegex);
  return m ? m[0] : null;
}

function basenameSlug(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "").replace(/\W+/g, "-").toLowerCase();
}

function intersect<T>(a: T[], b: T[]): T[] {
  const set = new Set(a);
  return b.filter((x) => set.has(x));
}

export interface GroupOptions {
  /** Branch that was current when the previous run ended. */
  initialBranch?: string | null;
  /** Session id → task name from earlier runs, so a session keeps one readable name. */
  initialSessions?: Record<string, string>;
}

export interface GroupResult {
  buckets: TaskBucket[];
  /** Sessions whose (branchless) work went to a session-named task in this run. */
  sessions: Record<string, string>;
}

// The branch that is current after the last event: git_context events set it, and so do hook events that carry one.
export function lastBranchOf(events: RawEvent[], initial: string | null = null): string | null {
  let branch = initial;
  for (const ev of events) {
    if (ev.event === "git_context") branch = ev.branch ?? null;
    else if (ev.source === "hook" && ev.branch) branch = ev.branch;
  }
  return branch;
}

/**
 * Task categories used for distillation classification.
 */
export type TaskCategory =
  | "debugging"
  | "refactoring"
  | "infra_ops"
  | "feature_dev"
  | "research_exploration"
  | "documentation";

/**
 * Classify a set of raw events into a high-level task category.
 *
 * Uses the decision engine when available, falls back to heuristic
 * keyword matching for the six canonical categories.
 *
 * @param events - The raw events to classify
 * @returns One of the six canonical task category strings
 */
export async function classifyTaskCategory(events: RawEvent[]): Promise<string> {
  // Build a text representation for classification
  const texts: string[] = [];
  for (const e of events) {
    if (e.text) texts.push(e.text);
    if (e.summary) texts.push(e.summary);
    if (e.msg) texts.push(e.msg);
    if (e.command) texts.push(e.command);
  }
  const context = texts.slice(0, 10).join(" ").slice(0, 800);
  if (!context.trim()) return "feature_dev"; // default

  const CATEGORIES: TaskCategory[] = [
    "debugging",
    "refactoring",
    "infra_ops",
    "feature_dev",
    "research_exploration",
    "documentation",
  ];

  // Try model-based classification first
  if (await decisionEngine.isAvailable()) {
    try {
      const result = await decisionEngine.classifyChoice(context, CATEGORIES);
      return result.selected as TaskCategory;
    } catch {
      // Fall through to heuristic
    }
  }

  // Heuristic fallback with priority order
  const combined = texts.join(" ").toLowerCase();

  // debugging: errors, exceptions, test failures, stack traces
  if (/error|exception|bug|fix|debug|stack.*trace|fail|assert|panic|segfault|crash|fatal|regression|traceback|unhandled/i.test(combined)) {
    return "debugging";
  }

  // infra_ops: deploy, docker, kubernetes, infra, CI/CD, database migrations, config changes
  if (/deploy|docker|kubernetes|infra|pipeline|ci.*cd|migration|config.*change|env\s*(update|change)|terraform|ansible|aws|gcp|azure|k8s/i.test(combined)) {
    return "infra_ops";
  }

  // refactoring: restructuring, cleanup, simplification
  if (/refactor|restructure|reorganize|cleanup|clean.?up|simplify|rename|extract.*method|remove.*dead|deprecate|consolidate/i.test(combined)) {
    return "refactoring";
  }

  // documentation: docs, readme, guide, tutorial
  if (/doc|readme|guide|how.?to|tutorial|document|write.?up|changelog|release.?notes|comment/i.test(combined)) {
    return "documentation";
  }

  // research_exploration: explore, investigate, poc, experiment
  if (/research|explore|investigate|proof.?of.?concept|poc|experiment|can.?i|how.*works|benchmark|compare.*with|evaluate/i.test(combined)) {
    return "research_exploration";
  }

  // feature_dev: implement, build, create, add, develop
  if (/implement|build|create.*feature|add.*function|develop|new.*endpoint|api|feature|module|plugin|integration/i.test(combined)) {
    return "feature_dev";
  }

  // Default
  return "feature_dev";
}

const SESSION_KEY = "\u0000session:";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function labelFor(events: RawEvent[]): string {
  const first = events.find((e) =>
    (e.event === "user_prompt" && e.text) || ((e.event === "agent_note" || e.event === "user_intent") && e.summary));
  const raw = first ? (first.text ?? first.summary ?? "") : "";
  // Task names land in the KB index and git backup, so text that looks like a credential never becomes one.
  if (/(password|passwd|pwd|secret|token|api[_-]?key|bearer|credential)/i.test(raw)) return slugify(events.find((e) => e.agent && e.agent !== "unknown")?.agent ?? "session") || "session";
  const words = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  const fromText = slugify(words.join(" ")).slice(0, 40).replace(/-+$/, "");
  return fromText || slugify(events.find((e) => e.agent && e.agent !== "unknown")?.agent ?? "session") || "session";
}

export const hhmm = (ts: string): string => `${ts.slice(11, 13)}${ts.slice(14, 16)}`;

export function groupEvents(
  events: RawEvent[],
  openTasks: JournalFrontmatter[],
  ticketRegex: RegExp,
  opts: GroupOptions = {},
): GroupResult {
  const bucketMap = new Map<string, TaskBucket>();
  const sessionTask = new Map<string, string>();       // session id → bucket key
  const seededSlugs = new Set<string>();
  const sessionKeys = new Set<string>();               // bucket keys that hold session-named work
  const pendingNames = new Set<string>();              // session keys still waiting for a readable name
  const sidEvents = new Map<string, RawEvent[]>();
  let currentBranch: string | null = opts.initialBranch ?? null;

  for (const ev of events) {
    if (ev.sid && ev.sid !== "unknown") sidEvents.set(ev.sid, [...(sidEvents.get(ev.sid) ?? []), ev]);
  }
  for (const [sid, slug] of Object.entries(opts.initialSessions ?? {})) {
    sessionTask.set(sid, slug);
    seededSlugs.add(slug);
  }

  function place(key: string, isNew: boolean, via: TaskBucket["matched_via"], ev: RawEvent, branch: string | null): void {
    let b = bucketMap.get(key);
    if (!b) {
      b = { task_slug: key, events: [], is_new: isNew, matched_via: via, branches: [] };
      bucketMap.set(key, b);
    }
    b.events.push(ev);
    if (branch && !b.branches!.includes(branch)) b.branches!.push(branch);
    if (ev.sid && ev.sid !== "unknown") sessionTask.set(ev.sid, key);
  }

  for (const ev of events) {
    if (ev.event === "git_context") {
      currentBranch = ev.branch ?? null;
      continue;
    }
    // A hook event is authoritative about its own branch: none means it ran outside a git repo, so it must not inherit one.
    let branch = currentBranch;
    if (ev.source === "hook") {
      branch = ev.branch ?? null;
      if (branch) currentBranch = branch;
    }

    // 1. Branch / ticket match (strongest)
    if (branch) {
      const ticketId = extractTicketId(branch, ticketRegex);
      if (ticketId) {
        const matchByTicket = openTasks.find((t) => t.git.ticket_ids.includes(ticketId));
        if (matchByTicket) {
          place(matchByTicket.task, false, "ticket", ev, branch);
          continue;
        }
      }
      const matchByBranch = openTasks.find((t) => t.git.branches.includes(branch!));
      if (matchByBranch) {
        place(matchByBranch.task, false, "branch", ev, branch);
        continue;
      }
    }

    // 2. Touched-files overlap
    const touched = ev.touched ?? [];
    if (touched.length > 0) {
      const ranked = openTasks
        .map((t) => ({ t, overlap: intersect(t.touched_files, touched).length }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap);
      if (ranked.length > 0) {
        place(ranked[0].t.task, false, "files", ev, branch);
        continue;
      }
    }

    // 3. Session affinity, only while the branch is unknown: once a branch is current it names the task, so the branch task must still be created.
    const previous = !branch && ev.sid ? sessionTask.get(ev.sid) : undefined;
    if (previous) {
      if (seededSlugs.has(previous)) sessionKeys.add(previous);
      place(previous, false, "session", ev, branch);
      continue;
    }

    // 4. Mint a new task
    if (branch) {
      const slug = extractTicketId(branch, ticketRegex) ?? basenameSlug(branch);
      place(slug, true, "minted", ev, branch);
    } else if (touched.length > 0) {
      place(`adhoc-${basenameSlug(touched[0])}`, true, "minted", ev, null);
    } else {
      const key = ev.sid && ev.sid !== "unknown" ? `${SESSION_KEY}${ev.sid}` : SESSION_KEY;
      place(key, true, "minted", ev, null);
      sessionKeys.add(key);
      pendingNames.add(key);
    }
  }

  // Name session tasks now that every event is known: <HHMM of first event>-<what the session was about>.
  const taken = new Set([...bucketMap.keys()].filter((k) => !pendingNames.has(k)));
  for (const key of pendingNames) {
    const b = bucketMap.get(key)!;
    const sid = key.slice(SESSION_KEY.length);
    const base = `${hhmm(b.events[0].ts)}-${labelFor(sid ? (sidEvents.get(sid) ?? b.events) : b.events)}`;
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    b.task_slug = slug;
  }

  const sessions: Record<string, string> = {};
  for (const [sid, key] of sessionTask) {
    const b = bucketMap.get(key);
    if (b && sessionKeys.has(key)) sessions[sid] = b.task_slug;
  }
  return { buckets: [...bucketMap.values()], sessions };
}

export function groupEventsIntoTasks(
  events: RawEvent[],
  openTasks: JournalFrontmatter[],
  ticketRegex: RegExp,
  opts: GroupOptions = {},
): TaskBucket[] {
  return groupEvents(events, openTasks, ticketRegex, opts).buckets;
}
