import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { upsertJournalMeta, journalMetaForFile, openTasksForProject, journalRefsByValue } from "../../src/journal/repository.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("journal repository", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-jrepo-test-"));
    createDatabase(join(testDir, "test.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();
    db.prepare(`INSERT INTO files (id, path, title, project_id, storage_type) VALUES (10, '/tmp/x.md', 'x', 1, 'local')`).run();
  });
  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("upserts journal_meta and joined touches + git_refs in one transaction", () => {
    upsertJournalMeta({
      file_id: 10,
      project_id: 1,
      task_slug: "websocket-recovery",
      status_latest: "investigating",
      started_at: "2026-04-12T09:14:00Z",
      last_active_at: "2026-05-12T16:14:33Z",
      touched_files: ["packages/core/src/websocket.ts"],
      raw_sources: ["raw/2026-05-12.jsonl@offset:0-89"],
      git_refs: [
        { ref_type: "branch", ref_value: "fix/INC-1234-websocket-drop" },
        { ref_type: "ticket", ref_value: "INC-1234" },
        { ref_type: "commit", ref_value: "a8b291c" },
      ],
    });

    const got = journalMetaForFile(10);
    expect(got?.task_slug).toBe("websocket-recovery");
    expect(got?.touched_files).toEqual(["packages/core/src/websocket.ts"]);

    const ticketHits = journalRefsByValue("ticket", "INC-1234");
    expect(ticketHits).toEqual([10]);
  });

  it("openTasksForProject returns rows ordered by last_active_at DESC", () => {
    upsertJournalMeta({ file_id: 10, project_id: 1, task_slug: "a", started_at: "2026-05-01T00:00Z", last_active_at: "2026-05-10T00:00Z", touched_files: [], raw_sources: [], git_refs: [] });
    const db = getDatabase();
    db.prepare(`INSERT INTO files (id, path, title, project_id, storage_type) VALUES (11, '/tmp/y.md', 'y', 1, 'local')`).run();
    upsertJournalMeta({ file_id: 11, project_id: 1, task_slug: "b", started_at: "2026-05-01T00:00Z", last_active_at: "2026-05-12T00:00Z", touched_files: [], raw_sources: [], git_refs: [] });

    const open = openTasksForProject(1, 90);
    expect(open.map((t) => t.task_slug)).toEqual(["b", "a"]);
  });
});
