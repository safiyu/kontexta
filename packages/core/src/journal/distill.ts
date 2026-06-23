// packages/core/src/journal/distill.ts
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawEvent, DistillResult, JournalFrontmatter } from "./types.js";
import { groupEventsIntoTasks } from "./topic-detector.js";
import { renderMechanicalEntry } from "./renderer.js";
import { readHighWater, writeHighWater } from "./high-water.js";
import { upsertJournalMeta, openTasksForProject } from "./repository.js";
import { getDatabase } from "../db/index.js";
import type { ExtraPatternDef } from "./patterns/extra-loader.js";
import { acquireCooldown, releaseCooldown } from "./cooldown.js";

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
    const hw = readHighWater(join(opts.dataDir, ...REL_BASE), opts.projectSlug);
    const since = hw?.last_event_ts ?? "0000-01-01T00:00:00Z";
    const seenKeys = new Set<string>(hw?.last_event_keys ?? []);
    const cutoff = new Date(opts.now.getTime() - opts.inFlightWindowSeconds * 1000).toISOString();

    // 1. READ
    const events = readRawEvents(opts, since, cutoff, opts.maxEvents, seenKeys);
    if (events.length === 0) {
      return { events_processed: 0, tasks_touched: [], tasks_created: [], high_water_advanced_to: since, warnings: [] };
    }

    // 2. GROUP
    const openTasks = loadOpenTasks(opts);
    const buckets = groupEventsIntoTasks(events, openTasks, opts.ticketRegex);

    // 3. RENDER + 4. INDEX
    const tasksTouched: string[] = [];
    const tasksCreated: string[] = [];

    for (const bucket of buckets) {
      const lastEvent = bucket.events[bucket.events.length - 1];
      const dir = distilledDir(opts, lastEvent.ts);
      mkdirSync(dir, { recursive: true });
      const filename = `task-${bucket.task_slug}.md`;
      const filePath = join(dir, filename);

      const fm: JournalFrontmatter = buildFrontmatter(bucket, opts.projectSlug);
      const entry = renderMechanicalEntry({
        task_slug: bucket.task_slug,
        events: bucket.events,
        now: lastEvent.ts,
        extraPatterns: opts.extraPatterns,
      });

      if (existsSync(filePath)) {
        // Re-emit frontmatter so last_active_at / touched_files / git_refs
        // reflect this run, then prepend the new entry above prior bodies.
        // Previously only the entry was prepended and the old frontmatter
        // was kept verbatim, diverging from what the DB row recorded.
        const existing = readFileSync(filePath, "utf8");
        const mergedFm = mergeFrontmatter(parseExistingFrontmatter(existing), fm);
        writeFileSync(filePath, replaceOrAppendEntry(existing, mergedFm, entry));
      } else {
        writeFileSync(filePath, serializeFrontmatter(fm) + "\n\n" + entry);
        tasksCreated.push(bucket.task_slug);
      }
      tasksTouched.push(bucket.task_slug);

      // Index — register the file in `files` table if not yet, then upsert journal_meta
      const fileId = ensureFileRecord(filePath, fm.task, opts.projectId);
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
    writeHighWater(join(opts.dataDir, ...REL_BASE), opts.projectSlug, {
      last_event_ts: newHw,
      last_event_keys: boundaryKeys,
      last_distilled_at: opts.now.toISOString(),
      events_processed: (hw?.events_processed ?? 0) + events.length,
    });

    return {
      events_processed: events.length,
      tasks_touched: tasksTouched,
      tasks_created: tasksCreated,
      high_water_advanced_to: newHw,
      warnings: [],
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
  const dirs = [rawDir(opts)];
  const defaultDir = join(opts.dataDir, ...REL_BASE, "default", "raw");
  if (defaultDir !== dirs[0] && existsSync(defaultDir)) {
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
          // If it's from the default dir, check project affinity.
          if (dir === defaultDir) {
            const matchesProject = (ev.args?.project_id === opts.projectId) ||
                                 (ev.touched?.some(p => p.startsWith(opts.projectSlug)));
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

function loadOpenTasks(opts: DistillJournalOpts): JournalFrontmatter[] {
  const rows = openTasksForProject(opts.projectId, opts.openTaskWindowDays);
  // Phase 1: load minimal frontmatter from DB; full FM read could be added later.
  return rows.map((r) => ({
    task: r.task_slug,
    project: opts.projectSlug,
    tags: [],
    touched_files: r.touched_files,
    git: { branches: [], commits: [], ticket_ids: [] }, // Phase 2: rebuild from journal_git_refs
    status_latest: r.status_latest,
    started_at: r.started_at,
    last_active_at: r.last_active_at,
    distilled_from: r.raw_sources,
  }));
}

function buildFrontmatter(
  bucket: { task_slug: string; events: RawEvent[]; is_new: boolean },
  projectSlug: string,
): JournalFrontmatter {
  const events = bucket.events;
  const touched = [...new Set(events.flatMap((e) => e.touched ?? []))];
  const branches = [...new Set(events.filter((e) => e.event === "git_context").map((e) => e.branch!).filter(Boolean))];
  const commits = events.filter((e) => e.event === "git_commit").map((e) => ({ sha: e.sha!, msg: e.msg ?? "", ts: e.ts }));
  const ticketRe = /[A-Z]+-\d+/;
  const tickets = [...new Set([
    ...branches.map((b) => b.match(ticketRe)?.[0]).filter(Boolean) as string[],
    ...commits.map((c) => c.msg.match(ticketRe)?.[0]).filter(Boolean) as string[],
  ])];
  const startedAt = events[0].ts;
  const lastActiveAt = events[events.length - 1].ts;
  return {
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

function parseExistingFrontmatter(existing: string): JournalFrontmatter | null {
  // Minimal extractor: we only consume what mergeFrontmatter needs from the
  // prior file; everything else gets overwritten by the new fm anyway. Treats
  // anything malformed as "no prior" — the caller then keeps fm as-is.
  if (!existing.startsWith("---\n")) return null;
  const end = existing.indexOf("\n---", 4);
  if (end < 0) return null;
  const block = existing.slice(4, end);
  const get = (k: string) => {
    const m = block.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const startedAt = get("started_at");
  if (!startedAt) return null;
  return {
    task: get("task"),
    project: get("project"),
    tags: [],
    touched_files: [],
    git: { branches: [], commits: [], ticket_ids: [] },
    status_latest: null,
    started_at: startedAt,
    last_active_at: get("last_active_at"),
    distilled_from: [],
  };
}

function mergeFrontmatter(
  prior: JournalFrontmatter | null,
  next: JournalFrontmatter,
): JournalFrontmatter {
  if (!prior) return next;
  // Preserve the original started_at (the file's earliest event). Everything
  // else is taken from the new batch — last_active_at, touched_files etc.
  // are intentionally overwritten so the DB and file agree.
  return { ...next, started_at: prior.started_at };
}

function ensureFileRecord(filePath: string, title: string, projectId: number): number {
  const db = getDatabase();
  const existing = db.prepare(`SELECT id FROM files WHERE path = ?`).get(filePath) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db.prepare(`
    INSERT INTO files (path, title, project_id, storage_type) VALUES (?, ?, ?, 'local')
  `).run(filePath, title, projectId);
  return Number(result.lastInsertRowid);
}
