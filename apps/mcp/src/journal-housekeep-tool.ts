// apps/mcp/src/journal-housekeep-tool.ts
import { z } from "zod";
import { housekeepJournal, getDataDir } from "kxta-core";
import { getCurrentProjectSlug } from "./journal-capture.js";

export function registerHousekeepTool(server: any): void {
  server.tool(
    "housekeep_journal",
    "Run journal retention/archival for a project. Idempotent. Prunes old raw .jsonl files and archives cold tasks per the configured retention policy.",
    {
      project_slug: z.string().optional(),
    },
    async ({ project_slug }: { project_slug?: string }) => {
      const slug = project_slug ?? getCurrentProjectSlug();
      const result = housekeepJournal({
        baseDir: `${getDataDir()}/knowledge/journal`,
        projectSlug: slug,
        retention: {
          raw_days: 90,
          mechanical_only_days: 365,
          narrative_days: 0,
          archive_cold_after_days: 365,
          purge_archived_after_days: 0,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
