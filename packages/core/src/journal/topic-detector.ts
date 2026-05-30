// packages/core/src/journal/topic-detector.ts
import type { RawEvent, TaskBucket, JournalFrontmatter } from "./types.js";

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

export function groupEventsIntoTasks(
  events: RawEvent[],
  openTasks: JournalFrontmatter[],
  ticketRegex: RegExp,
): TaskBucket[] {
  const bucketMap = new Map<string, TaskBucket>();
  let currentBranch: string | null = null;

  function bucketFor(slug: string, isNew: boolean, matchedVia: TaskBucket["matched_via"]): TaskBucket {
    let b = bucketMap.get(slug);
    if (!b) {
      b = { task_slug: slug, events: [], is_new: isNew, matched_via: matchedVia };
      bucketMap.set(slug, b);
    }
    return b;
  }

  for (const ev of events) {
    if (ev.event === "git_context") {
      currentBranch = ev.branch ?? null;
      continue;
    }

    // 1. Branch / ticket match (strongest)
    if (currentBranch) {
      const ticketId = extractTicketId(currentBranch, ticketRegex);
      if (ticketId) {
        const matchByTicket = openTasks.find((t) => t.git.ticket_ids.includes(ticketId));
        if (matchByTicket) {
          bucketFor(matchByTicket.task, false, "ticket").events.push(ev);
          continue;
        }
      }
      const matchByBranch = openTasks.find((t) => t.git.branches.includes(currentBranch!));
      if (matchByBranch) {
        bucketFor(matchByBranch.task, false, "branch").events.push(ev);
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
        bucketFor(ranked[0].t.task, false, "files").events.push(ev);
        continue;
      }
    }

    // 3. Mint a new task
    if (currentBranch) {
      const slug = extractTicketId(currentBranch, ticketRegex) ?? basenameSlug(currentBranch);
      bucketFor(slug, true, "minted").events.push(ev);
    } else if (touched.length > 0) {
      bucketFor(`adhoc-${basenameSlug(touched[0])}`, true, "minted").events.push(ev);
    } else {
      bucketFor("orphan", true, "minted").events.push(ev);
    }
  }

  return [...bucketMap.values()];
}
