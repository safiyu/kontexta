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

export interface TopicPivotResult {
  isPivot: boolean;
  confidence: number;
  suggestedNewSlug: string | null;
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

/**
 * Detect whether a new event represents a topic pivot from the current context.
 *
 * Uses the decision engine when available, falls back to heuristic keyword
 * checking for topic shifts.
 */
export async function detectTopicPivot(
  currentTaskContext: { title: string; recentFiles: string[]; lastFewEvents: string },
  nextEvent: { type: string; content: string; command?: string },
): Promise<TopicPivotResult> {
  const nextText = [nextEvent.content, nextEvent.command].filter(Boolean).join(" ");
  const contextText = `${currentTaskContext.title}\n\n${currentTaskContext.lastFewEvents}`;

  // Try model-based detection first
  if (await decisionEngine.isAvailable()) {
    try {
      const verdict = await decisionEngine.evaluateVerdict(
        `Current context: "${contextText.slice(0, 500)}"\n\nNext event: "${nextText.slice(0, 500)}" (type: ${nextEvent.type})`,
        "Does this event represent a distinct task pivot from the current context?",
      );

      if (verdict.verdict && confidenceForKeywords(nextText, contextText) > 0.6) {
        return {
          isPivot: true,
          confidence: Math.max(verdict.confidence, confidenceForKeywords(nextText, contextText)),
          suggestedNewSlug: generateSlugFromEvent(nextEvent),
        };
      }

      return { isPivot: false, confidence: 1 - verdict.confidence, suggestedNewSlug: null };
    } catch {
      // Fall back to heuristic keyword checking
    }
  }

  return heuristicTopicPivot(currentTaskContext, nextEvent);
}

/**
 * Calculate keyword-based confidence that a topic shift occurred.
 */
function confidenceForKeywords(nextText: string, contextText: string): number {
  const nextWords = new Set(nextText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const contextWords = new Set(contextText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));

  let overlapCount = 0;
  let significantCount = 0;

  // Domain keywords that indicate significant shifts
  const domainKeywords = [
    "database", "query", "sql", "index", "table", "schema",
    "api", "endpoint", "http", "route", "middleware",
    "ui", "component", "css", "style", "layout", "template",
    "test", "spec", "mock", "fixture",
    "deploy", "docker", "kubernetes", "infra", "pipeline",
    "auth", "permission", "role", "token", "session",
    "cache", "redis", "queue", "message", "worker",
  ];

  for (const word of nextWords) {
    if (!contextWords.has(word)) {
      significantCount++;
      if (domainKeywords.some((dk) => word.includes(dk) || dk.includes(word))) {
        overlapCount++;
      }
    }
  }

  if (significantCount === 0) return 0;

  // Higher overlap of domain-specific new words = higher confidence
  const ratio = overlapCount / significantCount;
  return Math.min(ratio * 1.5, 1.0); // Scale up slightly, cap at 1.0
}

/**
 * Generate a slug from the next event for potential new task naming.
 */
function generateSlugFromEvent(event: { type: string; content: string; command?: string }): string | null {
  const text = [event.content, event.command].filter(Boolean).join(" ").slice(0, 200);
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  return slugify(words.slice(0, 6).join(" "));
}

/**
 * Domain keyword groups for pivot detection.
 * Keywords within the same group are related, so a new keyword
 * from an already-active group should NOT count as a pivot.
 */
const DOMAIN_GROUPS: Record<string, string[]> = {
  auth: ["auth", "login", "token", "session", "credential", "permission", "role"],
  payment: ["payment", "billing", "stripe", "checkout", "invoice", "subscription"],
  database: ["database", "query", "sql", "index", "table", "schema", "migration"],
  api: ["api", "endpoint", "http", "route", "middleware", "handler"],
  ui: ["ui", "component", "css", "style", "layout", "template", "react"],
  infra: ["deploy", "docker", "kubernetes", "infra", "pipeline", "ci", "cd", "terraform"],
  test: ["test", "spec", "mock", "fixture", "jest", "cypress"],
  cache: ["cache", "redis", "queue", "message", "worker", "celery"],
};

/**
 * Heuristic fallback for topic pivot detection.
 * Uses keyword matching on common topic boundaries.
 */
function heuristicTopicPivot(
  currentTaskContext: { title: string; recentFiles: string[]; lastFewEvents: string },
  nextEvent: { type: string; content: string; command?: string },
): TopicPivotResult {
  const nextText = [nextEvent.content, nextEvent.command].filter(Boolean).join(" ");
  const contextText = `${currentTaskContext.title} ${currentTaskContext.lastFewEvents}`.toLowerCase();
  const nextLower = nextText.toLowerCase();

  // Check for file path shifts to different domains
  const currentFiles = new Set(currentTaskContext.recentFiles.map((f) => f.split("/").slice(0, 3).join("/")));
  const nextFiles = nextLower.match(/\b[a-z]+\/[a-z]+\/[a-z]+/g) ?? [];

  let fileShift = false;
  for (const f of nextFiles) {
    let inDomain = false;
    for (const cf of currentFiles) {
      if (f.startsWith(cf) || cf.startsWith(f)) { inDomain = true; break; }
    }
    if (!inDomain && f.split("/").length > 1) { fileShift = true; break; }
  }

  // Domain-grouped keyword matching: only count new keywords from
  // domains NOT already active in the context
  const activeDomains = new Set<string>();
  for (const [domain, keywords] of Object.entries(DOMAIN_GROUPS)) {
    if (keywords.some((kw) => contextText.includes(kw))) {
      activeDomains.add(domain);
    }
  }

  // Count how many new keywords come from each new domain
  let newDomainCount = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_GROUPS)) {
    if (activeDomains.has(domain)) continue; // Skip already-active domains
    // Check if next event introduces keywords from a new domain
    const newKeywordsInEvent = keywords.filter((kw) => nextLower.includes(kw));
    if (newKeywordsInEvent.length >= 1) {
      // 1 new keyword from a new domain counts as a shift indicator
      newDomainCount++;
    }
  }

  // Semantic shift detection: compare dominant action verbs and nouns
  // to catch pivots that don't use domain keywords
  const actionVerbs = ["implement", "build", "create", "add", "fix", "refactor", "rewrite", "migrate", "deploy", "configure"];
  const contextVerbs = new Set(actionVerbs.filter((v) => contextText.includes(v)));
  const nextVerbs = actionVerbs.filter((v) => nextLower.includes(v) && !contextVerbs.has(v));

  // Detect complete context shift: if next event has 2+ significant new words
  // that don't overlap with context at all, and neither is a common filler word
  const commonFillers = new Set(["the", "this", "that", "with", "for", "and", "a", "an", "to", "of", "in", "on", "at", "by", "is", "it", "be", "are", "was", "were", "implement", "new", "add", "rate", "limit"]);
  const nextWords = new Set(nextLower.split(/\s+/).filter((w) => w.length > 3 && !commonFillers.has(w)));
  const contextWords = new Set(contextText.split(/\s+/).filter((w) => w.length > 3));

  const uniqueNewWords = [...nextWords].filter((w) => !contextWords.has(w) && !commonFillers.has(w));

  // Check if the event also contains keywords from an active domain
  const hasActiveDomainKeywords = [...activeDomains].some(
    (domain) => DOMAIN_GROUPS[domain].some((kw) => nextLower.includes(kw))
  );

  // A pivot is likely when:
  // 1. We have 1+ domain keyword shifts to a new area AND event doesn't contain active domain keywords, OR
  // 2. We have 2+ domain shifts when event straddles active + new domains, OR
  // 3. We have 4+ completely new significant words AND no overlap in action verbs AND low overall overlap, OR
  // 4. File paths shifted to a new domain
  let isPivot = fileShift || (newDomainCount >= 1 && !hasActiveDomainKeywords) || (newDomainCount >= 2 && hasActiveDomainKeywords);
  let confidence = fileShift ? 0.8 : newDomainCount >= 1 ? 0.7 : 0.3;

  // If we have strong semantic signal, treat as pivot
  // Must be conservative: require very low overlap AND many new words
  if (!isPivot && uniqueNewWords.length >= 4 && nextVerbs.length >= 1 && contextWords.size > 0) {
    const sharedWords = [...nextWords].filter((w) => contextWords.has(w));
    const overlapRatio = contextWords.size > 0 ? sharedWords.length / contextWords.size : 1;

    if (overlapRatio < 0.2) {
      isPivot = true;
      confidence = 0.6 + (uniqueNewWords.length - 4) * 0.05;
      confidence = Math.min(confidence, 0.9);
    }
  }

  // Boost confidence if we have domain keywords AND semantic shift
  if (isPivot && newDomainCount >= 1 && uniqueNewWords.length >= 2) {
    confidence = Math.max(confidence, 0.7);
  }

  return {
    isPivot,
    confidence,
    suggestedNewSlug: isPivot ? generateSlugFromEvent(nextEvent) : null,
  };
}

const SESSION_KEY = "\u0000session:";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function labelFor(events: RawEvent[]): string {
  const first = events.find((e) =>
    (e.event === "user_prompt" && e.text) || ((e.event === "agent_note" || e.event === "user_intent") && e.summary));
  const raw = first ? (first.text ?? first.summary ?? "") : "";
  // Task names land in the KB index and git backup, so text that looks like a credential never becomes one.
  if (/(password|passwd|pwd|secret|token|api[_-]?key|bearer|credential)/i.test(raw)) return slugify(events.find((e) => e.agent && e.agent !== "unknown")?.agent ?? "session") || "session";
  const words = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  const fromText = slugify(words.join(" ")).slice(0, 40).replace(/-+$/, "");
  return fromText || slugify(events.find((e) => e.agent && e.agent !== "unknown")?.agent ?? "session") || "session";
}

const hhmm = (ts: string): string => `${ts.slice(11, 13)}${ts.slice(14, 16)}`;

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
