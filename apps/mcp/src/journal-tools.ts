// apps/mcp/src/journal-tools.ts
import { z } from "zod";
import { distillJournal, readHighWater, getDatabase } from "kxta-core";
import type { RawEvent } from "kxta-core";
import {
  appendVoluntaryEvent,
  getCurrentProjectSlug,
  getDataDir,
  getCurrentAgent,
  getCurrentSid,
} from "./journal-capture.js";

export function registerJournalTools(server: any): void {
  server.tool(
    "journal_note",
    "Record a free-form decision/abandonment/observation note in the current project's journal. Stored as an `agent_note` event in Layer 1; surfaces in distilled task entries.",
    {
      text: z.string().min(1).describe("Body of the note (markdown allowed)."),
      tags: z.array(z.string()).optional().describe("Optional tags for the note."),
    },
    async ({ text, tags }: { text: string; tags?: string[] }) => {
      const ev: RawEvent = {
        ts: new Date().toISOString(),
        agent: getCurrentAgent(),
        sid: getCurrentSid(),
        event: "agent_note",
        summary: text,
        tags: tags ?? [],
      };
      appendVoluntaryEvent(ev);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded_at: ev.ts }) }] };
    },
  );

  server.tool(
    "journal_intent",
    "Record a topic/intent pivot. Use when the user redirects what you're working on; the distillation step uses this to split task buckets correctly.",
    { summary: z.string().min(1).describe("One-line summary of the new intent.") },
    async ({ summary }: { summary: string }) => {
      const ev: RawEvent = {
        ts: new Date().toISOString(),
        agent: getCurrentAgent(),
        sid: getCurrentSid(),
        event: "user_intent",
        summary,
      };
      appendVoluntaryEvent(ev);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded_at: ev.ts }) }] };
    },
  );

  server.tool(
    "distill_journal",
    "Run the distillation pipeline: read raw events since the high-water mark, group by topic, write mechanical markdown entries, advance high-water. Idempotent.",
    {
      project_slug: z.string().optional(),
      max_events: z.number().int().positive().max(2000).optional(),
    },
    async ({ project_slug, max_events }: { project_slug?: string; max_events?: number }) => {
      const slug = project_slug ?? getCurrentProjectSlug();
      const db = getDatabase();
      const row = db.prepare(`SELECT id FROM projects WHERE slug = ?`).get(slug) as { id: number } | undefined;
      if (!row) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `unknown project_slug: ${slug}` }) }] };
      }
      const result = await distillJournal({
        projectSlug: slug,
        projectId: row.id,
        dataDir: getDataDir(),
        maxEvents: max_events ?? 200,
        ticketRegex: /[A-Z]+-\d+/,
        openTaskWindowDays: 90,
        inFlightWindowSeconds: 300,
        now: new Date(),
        cooldownSeconds: 60,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "journal_status",
    "Report the journal backlog and high-water mark for a project.",
    { project_slug: z.string().optional() },
    async ({ project_slug }: { project_slug?: string }) => {
      const slug = project_slug ?? getCurrentProjectSlug();
      const hw = readHighWater(`${getDataDir()}/knowledge/journal`, slug);
      return { content: [{ type: "text", text: JSON.stringify({ slug, high_water: hw, mode: "lenient" }, null, 2) }] };
    },
  );
}
