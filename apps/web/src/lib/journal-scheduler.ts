import { distillJournal, housekeepJournal, isMcpActive, getDatabase } from "kxta-core";

export interface SchedulerOptions {
  baseDir: string;        // <data> root
  mechanicalEveryMs?: number;
  housekeepEveryMs?: number;
  presenceWindowSec?: number;
}

export class JournalScheduler {
  private mechanicalTimer: NodeJS.Timeout | null = null;
  private housekeepTimer: NodeJS.Timeout | null = null;
  private opts: Required<SchedulerOptions>;

  constructor(opts: SchedulerOptions) {
    this.opts = {
      baseDir: opts.baseDir,
      mechanicalEveryMs: opts.mechanicalEveryMs ?? 15 * 60_000,
      housekeepEveryMs: opts.housekeepEveryMs ?? 24 * 60 * 60_000,
      presenceWindowSec: opts.presenceWindowSec ?? 30,
    };
  }

  start(): void {
    if (this.mechanicalTimer || this.housekeepTimer) return; // already started
    this.mechanicalTimer = setInterval(
      () => { this.runMechanicalForAllProjects().catch(() => {}); },
      this.opts.mechanicalEveryMs,
    );
    this.housekeepTimer = setInterval(
      () => { this.runHousekeepForAllProjects().catch(() => {}); },
      this.opts.housekeepEveryMs,
    );
    this.mechanicalTimer.unref?.();
    this.housekeepTimer.unref?.();
  }

  stop(): void {
    if (this.mechanicalTimer) clearInterval(this.mechanicalTimer);
    if (this.housekeepTimer) clearInterval(this.housekeepTimer);
    this.mechanicalTimer = null;
    this.housekeepTimer = null;
  }

  async runMechanicalForAllProjects(): Promise<void> {
    const db = getDatabase();
    const projects = db.prepare(`SELECT id, slug FROM projects`).all() as Array<{ id: number; slug: string }>;
    const journalBase = `${this.opts.baseDir}/knowledge/journal`;
    for (const p of projects) {
      if (isMcpActive(journalBase, p.slug, this.opts.presenceWindowSec)) continue;
      try {
        const result = await distillJournal({
          projectSlug: p.slug,
          projectId: p.id,
          dataDir: this.opts.baseDir,
          maxEvents: 200,
          ticketRegex: /[A-Z]+-\d+/,
          openTaskWindowDays: 90,
          inFlightWindowSeconds: 300,
          cooldownSeconds: 60,
          now: new Date(),
        });
        // Broadcast journal status update if work was done
        if (result.events_processed > 0 || result.tasks_touched.length > 0) {
          try {
            const wsModule = await import("./websocket.js");
            const broadcast = (wsModule as any).broadcast ?? (wsModule as any).broadcastSync;
            if (typeof broadcast === "function") {
              broadcast({
                type: "journal_status_update",
                project_slug: p.slug,
                ts: new Date().toISOString(),
                events_processed: result.events_processed,
                tasks_touched: result.tasks_touched,
              });
            }
          } catch { /* websocket optional; don't crash on broadcast failure */ }
        }
      } catch (err) {
        console.warn(`[journal-scheduler] mechanical distill failed for ${p.slug}`, err);
      }
    }
  }

  async runHousekeepForAllProjects(): Promise<void> {
    const db = getDatabase();
    const projects = db.prepare(`SELECT id, slug FROM projects`).all() as Array<{ id: number; slug: string }>;
    for (const p of projects) {
      try {
        housekeepJournal({
          baseDir: `${this.opts.baseDir}/knowledge/journal`,
          projectSlug: p.slug,
          retention: { raw_days: 90, mechanical_only_days: 365, narrative_days: 0, archive_cold_after_days: 365, purge_archived_after_days: 0 },
        });
      } catch (err) {
        console.warn(`[journal-scheduler] housekeep failed for ${p.slug}`, err);
      }
    }
  }
}
