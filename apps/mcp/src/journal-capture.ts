import { getDataDir, JournalWriter, defaultRedactConfig, redactArgs, checkGit, readHighWater, shouldBlock, backlogErrorPayload, type GitWatcherState } from "kxta-core";
import type { RawEvent } from "kxta-core";
import { readdirSync, readFileSync as fsReadFileSync, existsSync as fsExistsSync } from "node:fs";

interface CaptureContext {
  writer: JournalWriter;
  projectSlug: string;
  agent: string;
  sid: string;
}

let ctx: CaptureContext | null = null;

export interface InitCaptureOpts {
  projectSlug: string;
  baseDir: string;            // e.g. <data>/knowledge/journal
  agent: string;
  sid: string;
}

export function initCapture(opts: InitCaptureOpts): void {
  ctx = {
    writer: new JournalWriter({ projectSlug: opts.projectSlug, baseDir: opts.baseDir }),
    projectSlug: opts.projectSlug,
    agent: opts.agent,
    sid: opts.sid,
  };
}

export function shutdownCapture(): void {
  stopGitPoller();
  ctx?.writer.close();
  ctx = null;
}

type Handler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

let _modeCache: { mode: "lenient" | "strict" | "mechanical-only"; ts: number } | null = null;

function readJournalMode(): "lenient" | "strict" | "mechanical-only" {
  const now = Date.now();
  if (_modeCache && now - _modeCache.ts < 5000) return _modeCache.mode;
  const cfgPath = `${getDataDir()}/kontexta.json`;
  let mode: "lenient" | "strict" | "mechanical-only" = "lenient";
  // Also check project root in case caller put kontexta.json there
  const fallback = `${process.cwd()}/kontexta.json`;
  for (const p of [cfgPath, fallback]) {
    if (fsExistsSync(p)) {
      try {
        const obj = JSON.parse(fsReadFileSync(p, "utf8"));
        if (obj?.journal?.mode === "strict" || obj?.journal?.mode === "mechanical-only" || obj?.journal?.mode === "lenient") {
          mode = obj.journal.mode;
          break;
        }
      } catch { /* ignore */ }
    }
  }
  _modeCache = { mode, ts: now };
  return mode;
}

export function resetModeCache(): void {
  _modeCache = null;
}

export function wrapHandler<TArgs extends Record<string, unknown>, TResult extends { isError?: boolean; content: any }>(
  toolName: string,
  inner: Handler<TArgs, TResult>,
): Handler<TArgs, TResult> {
  return async (args: TArgs) => {
    // Strict-mode preflight (Task 26)
    const mode = readJournalMode();
    const bypass = (args as any).journal_bypass === true;
    const status = getBacklogStatus(getCurrentProjectSlug());
    if (shouldBlock(mode, toolName, status, bypass)) {
      const payload = backlogErrorPayload(status);
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] } as any;
    }
    // Strip journal_bypass from args so it doesn't leak to the inner handler
    const cleanArgs: any = { ...args };
    delete cleanArgs.journal_bypass;

    const start = Date.now();
    let result: TResult;
    try {
      result = await inner(cleanArgs as TArgs);
    } catch (err) {
      activitySinceLastCheck = true;
      tryWriteEvent({
        ts: new Date().toISOString(),
        agent: ctx?.agent ?? "unknown",
        sid: ctx?.sid ?? "unknown",
        event: "error",
        tool: toolName,
        args: ctx ? redactArgs(cleanArgs, defaultRedactConfig) : cleanArgs,
        touched: extractTouched(cleanArgs),
        status: "error",
        ms: Date.now() - start,
        msg: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    activitySinceLastCheck = true;
    tryWriteEvent({
      ts: new Date().toISOString(),
      agent: ctx?.agent ?? "unknown",
      sid: ctx?.sid ?? "unknown",
      event: "tool_call",
      tool: toolName,
      args: ctx ? redactArgs(cleanArgs, defaultRedactConfig) : cleanArgs,
      touched: extractTouched(cleanArgs),
      status: result.isError ? "error" : "ok",
      ms: Date.now() - start,
    });
    // Lenient-mode envelope + mechanical fallback (Task 16)
    try {
      const status = getBacklogStatus(getCurrentProjectSlug());
      if (status.backlog_events >= 1) {
        const orig = (result as any).content?.[0]?.text;
        if (typeof orig === "string") {
          let parsed: any;
          let isPlainObject = false;
          try {
            parsed = JSON.parse(orig);
            // Only inject into plain objects — NOT arrays (spread would corrupt to {"0":…})
            // and NOT raw text that failed to parse (e.g. Hands confirm token strings).
            isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
          } catch { /* not JSON — leave response untouched */ }
          if (isPlainObject) {
            const envelope = {
              ...parsed,
              journal: {
                backlog_events: status.backlog_events,
                backlog_oldest_age_hours: status.backlog_oldest_age_hours,
                high_water: status.high_water,
                suggested_action: "distill_journal",
                mode: "lenient",
              },
            };
            (result as any) = { ...result, content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
          }
        }
      }
      const BACKLOG_THRESHOLD_EVENTS = 500;
      const BACKLOG_THRESHOLD_HOURS = 7 * 24;
      if (status.backlog_events >= BACKLOG_THRESHOLD_EVENTS ||
        (status.backlog_oldest_age_hours ?? 0) >= BACKLOG_THRESHOLD_HOURS) {
        // Fire-and-forget mechanical distillation
        setImmediate(async () => {
          try {
            const { distillJournal, getDatabase } = await import("kxta-core");
            const db = getDatabase();
            const row = (db as any).prepare(`SELECT id FROM projects WHERE slug = ?`).get(getCurrentProjectSlug()) as { id: number } | undefined;
            if (row) {
              await distillJournal({
                projectSlug: getCurrentProjectSlug(),
                projectId: row.id,
                dataDir: getDataDir(),
                maxEvents: 500,
                ticketRegex: /[A-Z]+-\d+/,
                openTaskWindowDays: 90,
                inFlightWindowSeconds: 300,
                now: new Date(),
              });
            }
          } catch (err) {
            console.warn("[journal-capture] mechanical fallback failed", err);
          }
        });
      }
    } catch (err) {
      console.warn("[journal-capture] envelope/fallback bookkeeping failed", err);
    }
    return result;
  };
}

function tryWriteEvent(ev: RawEvent): void {
  if (!ctx) return; // capture not initialised — swallow
  try {
    ctx.writer.append(ev);
  } catch (err) {
    console.warn("[journal-capture] write failed; swallowed", err);
  }
}

function extractTouched(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args.path === "string") out.push(args.path);
  if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string") out.push(p);
  return out;
}

let gitState: GitWatcherState = { branch: null, head: null };
let gitTimer: NodeJS.Timeout | null = null;
let activitySinceLastCheck = false;

export function appendVoluntaryEvent(ev: RawEvent): void {
  tryWriteEvent(ev);
}

export function getCurrentProjectSlug(): string {
  return ctx?.projectSlug ?? "default";
}
export function getCurrentAgent(): string {
  return ctx?.agent ?? "unknown";
}
export function getCurrentSid(): string {
  return ctx?.sid ?? "unknown";
}



export function startGitPoller(projectPath: string, intervalSec: number = 30): void {
  if (gitTimer) clearInterval(gitTimer);
  gitTimer = setInterval(async () => {
    if (!activitySinceLastCheck) return;
    activitySinceLastCheck = false;
    try {
      const events = await checkGit(projectPath, gitState, {
        agent: ctx?.agent, sid: ctx?.sid, project: ctx?.projectSlug,
      });
      for (const ev of events) tryWriteEvent(ev);
    } catch (err) {
      console.warn("[journal-capture] git poll failed; swallowed", err);
    }
  }, intervalSec * 1000);
  gitTimer.unref?.();
}

export function stopGitPoller(): void {
  if (gitTimer) {
    clearInterval(gitTimer);
    gitTimer = null;
  }
}

export function getBacklogStatus(projectSlug: string): {
  backlog_events: number;
  backlog_oldest_age_hours: number | null;
  high_water: string | null;
} {
  const baseDir = `${getDataDir()}/knowledge/journal`;
  const hw = readHighWater(baseDir, projectSlug);
  const sinceTs = hw?.last_event_ts ?? "0000-01-01T00:00:00Z";
  const rawDir = `${baseDir}/${projectSlug}/raw`;
  let count = 0;
  let oldest: string | null = null;
  try {
    for (const f of readdirSync(rawDir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const lines = fsReadFileSync(`${rawDir}/${f}`, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.ts > sinceTs) {
            count++;
            if (!oldest || ev.ts < oldest) oldest = ev.ts;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* dir missing */ }
  const ageH = oldest ? (Date.now() - new Date(oldest).getTime()) / 3_600_000 : null;
  return { backlog_events: count, backlog_oldest_age_hours: ageH, high_water: hw?.last_event_ts ?? null };
}
