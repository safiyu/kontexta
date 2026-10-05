// packages/core/src/journal/distill.ts
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawEvent, DistillResult, JournalFrontmatter } from "./types.js";
import { groupEvents, lastBranchOf, classifyTaskCategory } from "./topic-detector.js";
import { renderMechanicalEntry, touchedFilesOf } from "./renderer.js";
import { readHighWater, writeHighWater } from "./high-water.js";
import { upsertJournalMeta, openTasksForProject, gitRefsForFiles } from "./repository.js";
import { getDatabase } from "../db/index.js";
import type { ExtraPatternDef } from "./patterns/extra-loader.js";
import { acquireCooldown, releaseCooldown } from "./cooldown.js";
import { splitBucketsOnPivots } from "./pivot.js";
import { readJournalIntelligence, type JournalIntelligence } from "./intelligence-config.js";
import type { EmbedFn } from "../inference/embeddings.js";
import { markVerified } from "../hooks/registry.js";

export interface DistillJournalOpts {
  projectSlug: string;
  projectId: number;
  dataDir: string;             // e.g. /path/to/data (the writer also uses this)
  maxEvents: number;
  ticketRegex: RegExp;
  openTaskWindowDays: number;
  inFlightWindowSeconds: number;
  now: Date;
  extraPatterns?: ExtraPatternDef[];
  cooldownSeconds?: number;
  /** Reprocess this fixed window of raw events instead of continuing from the high-water mark; the mark is neither read nor written. */
  range?: { since: string; until: string };
  /** Overrides journal.distillation.decision_engine from kontexta.json. */
  intelligence?: JournalIntelligence;
  /** Embedding function for topic-pivot detection; tests inject a fake. */
  embed?: EmbedFn;
}

const REL_BASE = ["knowledge", "journal"]; // joined under dataDir

function rawDir(opts: DistillJournalOpts): string {
  return join(opts.dataDir, ...REL_BASE, opts.projectSlug, "raw");
}
function distilledDir(opts: DistillJournalOpts, ts: string): string {
  return join(opts.dataDir, ...REL_BASE, opts.projectSlug, ts.slice(0, 4), ts.slice(5, 7), ts.slice(8, 10));
}

export async function distillJournal(opts: DistillJournalOpts): Promise<DistillResult> {
  const cooldownBase = join(opts.dataDir, ...REL_BASE);
  // Default 60s is the minimum window in which two redundant distill runs are
  // unlikely to produce useful work; previously the default of 0 made the
  // cooldown lock vacuous (always-stale).
  const cooldownSec = opts.cooldownSeconds ?? 60;
  const lockToken = acquireCooldown(cooldownBase, opts.projectSlug, cooldownSec);
  if (!lockToken) {
    return {
      events_processed: 0,
      tasks_touched: [],
      tasks_created: [],
      high_water_advanced_to: "",
      warnings: ["cooldown active"],
    };
  }
  try {
    const hw = opts.range ? null : readHighWater(join(opts.dataDir, ...REL_BASE), opts.projectSlug);
    const since = opts.range?.since ?? hw?.last_event_ts ?? "0000-01-01T00:00:00Z";
    const seenKeys = new Set<string>(hw?.last_event_keys ?? []);
    const cutoff = opts.range?.until ?? new Date(opts.now.getTime() - opts.inFlightWindowSeconds * 1000).toISOString();

    // 1. READ
    const events = readRawEvents(opts, since, cutoff, opts.maxEvents, seenKeys);
    if (events.length === 0) {
      return { events_processed: 0, tasks_touched: [], tasks_created: [], high_water_advanced_to: since, warnings: [] };
    }

    // One transaction with the first/last hook timestamp per agent, not one auto-committed UPDATE per event.
    const hookSeen = new Map<string, { first: string; last: string }>();
    for (const ev of events) {
      if (ev.source !== "hook" || !ev.agent) continue;
      const seen = hookSeen.get(ev.agent);
      if (!seen) hookSeen.set(ev.agent, { first: ev.ts, last: ev.ts });
      else { if (ev.ts < seen.first) seen.first = ev.ts; if (ev.ts > seen.last) seen.last = ev.ts; }
    }
    if (hookSeen.size > 0) {
      try {
        getDatabase().transaction(() => {
          for (const [agent, { first, last }] of hookSeen) { markVerified(agent, first); if (last !== first) markVerified(agent, last); }
        })();
      } catch { /* registry is best-effort during distill */ }
    }

    // 2. GROUP
    const openTasks = loadOpenTasks(opts);
    const grouped = groupEvents(events, openTasks, opts.ticketRegex, { initialBranch: hw?.last_branch ?? null, initialSessions: hw?.session_tasks });
    const intel = opts.intelligence ?? readJournalIntelligence(opts.dataDir);
    const warnings: string[] = [];
    let buckets = grouped.buckets;
    let sessions = grouped.sessions;
    let promptSeeds = hw?.session_prompts;
    if (intel.topicPivotDetection) {
      const split = await splitBucketsOnPivots(buckets, { embed: opts.embed, threshold: intel.pivotThreshold, seeds: opts.range ? undefined : hw?.session_prompts });
      if (split) {
        buckets = split.buckets;
        sessions = { ...sessions, ...split.sessions };
        promptSeeds = mergeKeepingRecent(hw?.session_prompts, split.seeds);
      } else {
        warnings.push("topic pivot detection skipped: embedding model unavailable");
      }
    }

    // 3. RENDER + 4. INDEX
    const tasksTouched: string[] = [];
    const tasksCreated: string[] = [];

    for (const bucket of buckets) {
      const lastEvent = bucket.events[bucket.events.length - 1];
      const dir = distilledDir(opts, lastEvent.ts);
      mkdirSync(dir, { recursive: true });
      const filename = `task-${bucket.task_slug}.md`;
      const filePath = join(dir, filename);

      let fm: JournalFrontmatter = await buildFrontmatter(bucket, opts.projectSlug, intel.taskCategorization);
      const entry = renderMechanicalEntry({
        task_slug: bucket.task_slug,
        events: bucket.events,
        now: lastEvent.ts,
        extraPatterns: opts.extraPatterns,
        collapseNoise: intel.eventTriage,
      });

      if (existsSync(filePath)) {
        // Accumulate with what earlier runs recorded so the DB row and next run's task matching keep the whole history, not just this batch.
        const existing = readFileSync(filePath, "utf8");
        fm = mergeFrontmatter(parseFrontmatter(existing), fm);
        writeFileSync(filePath, replaceOrAppendEntry(existing, fm, entry));
      } else {
        writeFileSync(filePath, serializeFrontmatter(fm) + "\n\n" + entry);
        tasksCreated.push(bucket.task_slug);
      }
      tasksTouched.push(bucket.task_slug);

      // Index — register the file in `files` table if not yet, then upsert journal_meta
      const fileId = ensureFileRecord(filePath, fm.task);
      upsertJournalMeta({
        file_id: fileId,
        project_id: opts.projectId,
        task_slug: bucket.task_slug,
        status_latest: pickStatusFromTags(fm.tags),
        started_at: fm.started_at,
        last_active_at: fm.last_active_at,
        touched_files: fm.touched_files,
        raw_sources: fm.distilled_from,
        git_refs: gitRefsFor(fm),
      });
    }

    // 5. ADVANCE high-water
    // Use the LATEST ts across all events (sorted). Persist the per-event
    // dedup keys for events that share that exact ts, so on the next run we
    // can filter with `ev.ts >= newHw && !seenKeys.has(key)` and avoid
    // dropping any event that shared a sub-ms timestamp with the boundary.
    const newHw = events[events.length - 1].ts;
    const boundaryKeys = events
      .filter((e) => e.ts === newHw)
      .map((e) => eventKey(e));
    if (!opts.range) {
      writeHighWater(join(opts.dataDir, ...REL_BASE), opts.projectSlug, {
        last_event_ts: newHw,
        last_event_keys: boundaryKeys,
        last_distilled_at: opts.now.toISOString(),
        events_processed: (hw?.events_processed ?? 0) + events.length,
        last_branch: lastBranchOf(events, hw?.last_branch ?? null),
        session_tasks: mergeSessionTasks(hw?.session_tasks, sessions),
        ...(promptSeeds ? { session_prompts: promptSeeds } : {}),
      });
    }

    return {
      events_processed: events.length,
      tasks_touched: tasksTouched,
      tasks_created: tasksCreated,
      high_water_advanced_to: opts.range ? "" : newHw,
      warnings,
    };
  } finally {
    releaseCooldown(cooldownBase, opts.projectSlug, lockToken);
  }
}

/**
 * Stable key for a raw event so we can distinguish two events that happen to
 * share the same ISO ms timestamp. Combines ts + event type + first touched
 * path (or sha/branch for git events) which is unique in practice.
 */
function eventKey(ev: RawEvent): string {
  const tail = ev.sha
    ?? ev.branch
    ?? (ev.touched?.[0] ?? "")
    ?? "";
  return `${ev.ts}|${ev.event}|${tail}`;
}

function readRawEvents(
  opts: DistillJournalOpts,
  sinceTs: string,
  untilTs: string,
  max: number,
  seenKeys: Set<string>,
): RawEvent[] {
  const primaryDir = rawDir(opts);
  const dirs = [primaryDir];
  const defaultDir = join(opts.dataDir, ...REL_BASE, "default", "raw");
  const isMergedDefaultDir = defaultDir !== primaryDir;
  if (isMergedDefaultDir && existsSync(defaultDir)) {
    dirs.push(defaultDir);
  }

  // Collect ALL candidate events first (no per-source truncation), then sort
  // by ts, THEN truncate. The previous implementation returned early at
  // `max` while still inside the primary dir — defaultDir events with a
  // smaller ts that should have come first were silently skipped, and the
  // high-water advanced past them so they were lost forever.
  const all: RawEvent[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as RawEvent;
          // Use >= with a per-event dedup key — two events sharing the same
          // ms timestamp at the high-water boundary would both qualify with
          // the previous strict `>` filter from only one direction; this
          // way we include them all on the boundary and skip the ones the
          // previous run already processed.
          if (ev.ts < sinceTs || ev.ts >= untilTs) continue;
          if (seenKeys.has(eventKey(ev))) continue;
          // If it's from the merged-in default dir (not the primary dir,
          // which happens to also be "default" when opts.projectSlug is
          // itself "default"), check project affinity.
          if (isMergedDefaultDir && dir === defaultDir) {
            const matchesProject = (ev.args?.project_id === opts.projectId) ||
                                 (ev.touched?.some(p => { const n = p.replace(/\\/g, "/"); return n === opts.projectSlug || n.startsWith(`${opts.projectSlug}/`) || n.includes(`/${opts.projectSlug}/`); }));
            if (!matchesProject) continue;
          }
          all.push(ev);
        } catch {
          // skip malformed line
        }
      }
    }
  }
  all.sort((a, b) => a.ts.localeCompare(b.ts));
  return all.slice(0, max);
}

// Most recently used sessions win the cap, so a long-running install doesn't grow this map forever.
const MAX_REMEMBERED_SESSIONS = 200;
// Fresh sessions go last so the cap drops the least recently active ones.
function mergeKeepingRecent(prior: Record<string, string[]> | undefined, fresh: Record<string, string[]>): Record<string, string[]> {
  const merged = { ...(prior ?? {}) };
  for (const [sid, prompts] of Object.entries(fresh)) { delete merged[sid]; merged[sid] = prompts; }
  return Object.fromEntries(Object.entries(merged).slice(-MAX_REMEMBERED_SESSIONS));
}

function mergeSessionTasks(prior: Record<string, string> | undefined, fresh: Record<string, string>): Record<string, string> {
  const kept = Object.entries(prior ?? {}).filter(([sid]) => !(sid in fresh));
  return Object.fromEntries([...kept, ...Object.entries(fresh)].slice(-MAX_REMEMBERED_SESSIONS));
}

function loadOpenTasks(opts: DistillJournalOpts): JournalFrontmatter[] {
  const rows = openTasksForProject(opts.projectId, opts.openTaskWindowDays);
  const refs = gitRefsForFiles(rows.map((r) => r.file_id));
  return rows.map((r) => {
    const rr = refs.get(r.file_id) ?? [];
    const values = (type: string) => rr.filter((x) => x.ref_type === type).map((x) => x.ref_value);
    return {
      task: r.task_slug,
      project: opts.projectSlug,
      tags: [],
      touched_files: r.touched_files,
      git: {
        branches: values("branch"),
        commits: values("commit").map((sha) => ({ sha, msg: "", ts: "" })),
        ticket_ids: values("ticket"),
      },
      status_latest: r.status_latest,
      started_at: r.started_at,
      last_active_at: r.last_active_at,
      distilled_from: r.raw_sources,
    };
  });
}

async function buildFrontmatter(
  bucket: { task_slug: string; events: RawEvent[]; is_new: boolean; branches?: string[] },
  projectSlug: string,
  categorize: boolean,
): Promise<JournalFrontmatter> {
  const events = bucket.events;
  const touched = touchedFilesOf(events);
  // git_context events are consumed by the grouper rather than bucketed, so the bucket carries the branches that were current.
  const branches = [...new Set([...(bucket.branches ?? []), ...events.filter((e) => e.event === "git_context").map((e) => e.branch!).filter(Boolean)])];
  const commits = events.filter((e) => e.event === "git_commit").map((e) => ({ sha: e.sha!, msg: e.msg ?? "", ts: e.ts }));
  const ticketRe = /[A-Z]+-\d+/;
  const tickets = [...new Set([
    ...branches.map((b) => b.match(ticketRe)?.[0]).filter(Boolean) as string[],
    ...commits.map((c) => c.msg.match(ticketRe)?.[0]).filter(Boolean) as string[],
  ])];
  const startedAt = events[0].ts;
  const lastActiveAt = events[events.length - 1].ts;
  
  // Classify task category (async, may fall back to heuristic)
  let category: string | undefined;
  try {
    if (categorize) category = await classifyTaskCategory(events);
  } catch {
    // Best-effort: skip category if classification fails
  }
  
  const frontmatter: JournalFrontmatter = {
    task: bucket.task_slug,
    project: projectSlug,
    tags: ["mechanical"],
    touched_files: touched,
    git: { branches, commits, ticket_ids: tickets },
    status_latest: null,
    started_at: startedAt,
    last_active_at: lastActiveAt,
    distilled_from: [`raw/${startedAt.slice(0, 10)}.jsonl`], // approximate; refine if multi-day
  };
  
  // Inject category if available
  if (category) {
    frontmatter.category = category;
  }
  
  return frontmatter;
}

function gitRefsFor(fm: JournalFrontmatter): Array<{ ref_type: "branch" | "commit" | "ticket"; ref_value: string }> {
  return [
    ...fm.git.branches.map((b) => ({ ref_type: "branch" as const, ref_value: b })),
    ...fm.git.commits.map((c) => ({ ref_type: "commit" as const, ref_value: c.sha })),
    ...fm.git.ticket_ids.map((t) => ({ ref_type: "ticket" as const, ref_value: t })),
  ];
}

function pickStatusFromTags(tags: string[]): string | null {
  for (const t of ["resolved", "unresolved", "investigating", "exploration", "tests-failing", "tests-passing"]) {
    if (tags.includes(t)) return t;
  }
  return null;
}

function serializeFrontmatter(fm: JournalFrontmatter): string {
  // Inline YAML serializer (avoid dep). Order keys deterministically.
  const yaml = [
    "---",
    `task: ${fm.task}`,
    `project: ${fm.project}`,
    `tags: [${fm.tags.join(", ")}]`,
    `touched_files:`,
    ...fm.touched_files.map((f) => `  - ${f}`),
    `git:`,
    `  branches: [${fm.git.branches.join(", ")}]`,
    `  commits:`,
    ...fm.git.commits.map((c) => `    - { sha: ${c.sha}, msg: ${JSON.stringify(c.msg)}, ts: ${c.ts} }`),
    `  ticket_ids: [${fm.git.ticket_ids.join(", ")}]`,
    `status_latest: ${fm.status_latest ?? "null"}`,
    `started_at: ${fm.started_at}`,
    `last_active_at: ${fm.last_active_at}`,
    `distilled_from:`,
    ...fm.distilled_from.map((s) => `  - ${s}`),
    "---",
  ];
  return yaml.join("\n");
}

function replaceOrAppendEntry(existing: string, fm: JournalFrontmatter, newEntry: string): string {
  // Replace the frontmatter block entirely with the merged value, then
  // prepend the new entry just below it. Entries below remain in order.
  const fmEnd = existing.indexOf("\n---", 4) + 4;
  const body = existing.slice(fmEnd);
  return serializeFrontmatter(fm) + "\n\n" + newEntry + body;
}

// Parses the frontmatter this file's own serializer wrote; anything malformed means "no prior" and the caller keeps the new value.
function parseFrontmatter(existing: string): JournalFrontmatter | null {
  if (!existing.startsWith("---\n")) return null;
  const end = existing.indexOf("\n---", 4);
  if (end < 0) return null;
  const block = existing.slice(4, end);
  const lines = block.split("\n");
  const scalar = (k: string): string => {
    const m = block.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const inline = (k: string): string[] => {
    const m = block.match(new RegExp(`^\\s*${k}:\\s*\\[(.*)\\]\\s*$`, "m"));
    return m && m[1].trim() ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
  };
  const list = (k: string): string[] => {
    const i = lines.findIndex((l) => l === `${k}:`);
    if (i < 0) return [];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^  - (.*)$/.exec(lines[j]);
      if (!m) break;
      out.push(m[1]);
    }
    return out;
  };
  const commits: Array<{ sha: string; msg: string; ts: string }> = [];
  for (const l of lines) {
    const m = /^\s{4}- \{ sha: (\S+), msg: (".*"), ts: (\S+) \}$/.exec(l);
    if (!m) continue;
    let msg = "";
    try { msg = JSON.parse(m[2]); } catch { /* keep empty message */ }
    commits.push({ sha: m[1], msg, ts: m[3] });
  }
  const startedAt = scalar("started_at");
  if (!startedAt) return null;
  return {
    task: scalar("task"),
    project: scalar("project"),
    tags: inline("tags"),
    touched_files: list("touched_files"),
    git: { branches: inline("branches"), commits, ticket_ids: inline("ticket_ids") },
    status_latest: null,
    started_at: startedAt,
    last_active_at: scalar("last_active_at"),
    distilled_from: list("distilled_from"),
  };
}

function mergeFrontmatter(
  prior: JournalFrontmatter | null,
  next: JournalFrontmatter,
): JournalFrontmatter {
  if (!prior) return next;
  const union = <T>(a: T[], b: T[]): T[] => [...new Set([...a, ...b])];
  const commits = [...prior.git.commits];
  for (const c of next.git.commits) if (!commits.some((x) => x.sha === c.sha)) commits.push(c);
  return {
    ...next,
    started_at: prior.started_at,
    touched_files: union(prior.touched_files, next.touched_files),
    git: {
      branches: union(prior.git.branches, next.git.branches),
      commits,
      ticket_ids: union(prior.git.ticket_ids, next.git.ticket_ids),
    },
    distilled_from: union(prior.distilled_from, next.distilled_from),
  };
}

// Journal files are KB files (no project on the files row); journal_meta.project_id records the owning project.
function ensureFileRecord(filePath: string, title: string): number {
  const db = getDatabase();
  const existing = db.prepare(`SELECT id FROM files WHERE path = ?`).get(filePath) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE files SET project_id = NULL WHERE id = ? AND project_id IS NOT NULL`).run(existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO files (path, title, project_id, storage_type) VALUES (?, ?, NULL, 'local')
  `).run(filePath, title);
  return Number(result.lastInsertRowid);
}
