// apps/mcp/src/journal-commit-upgrades-tool.ts
import { z } from "zod";
import { markUpgradeApplied, getDatabase } from "kxta-core";

export function registerCommitUpgradesTool(server: any): void {
  server.tool(
    "distill_journal_commit_upgrades",
    "After dispatching subagents to upgrade mechanical journal entries to LLM-narrative, call this with the affected task slugs. Updates journal_meta.status_latest to mark the entries as upgraded.",
    {
      task_slugs: z.array(z.string()).min(1).describe("Task slugs whose entries were upgraded by subagents."),
    },
    async ({ task_slugs }: { task_slugs: string[] }) => {
      const db = getDatabase();
      const updated: string[] = [];
      const missing: string[] = [];
      for (const slug of task_slugs) {
        const row = db.prepare(`SELECT file_id FROM journal_meta WHERE task_slug = ?`).get(slug) as { file_id: number } | undefined;
        if (row) {
          markUpgradeApplied(row.file_id, "upgraded");
          updated.push(slug);
        } else {
          missing.push(slug);
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ updated, missing }, null, 2) }] };
    },
  );
}
