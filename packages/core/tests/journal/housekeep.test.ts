// packages/core/tests/journal/housekeep.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { housekeepJournal } from "../../src/journal/housekeep.js";

describe("housekeepJournal", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-housekeep-"));
    createDatabase(join(testDir, "test.db"));
  });
  afterEach(() => { closeDatabase(); rmSync(testDir, { recursive: true, force: true }); });

  function event(ts: string) {
    return JSON.stringify({ ts, agent: "x", sid: "s", event: "tool_call", tool: "search" }) + "\n";
  }

  it("prunes raw .jsonl files older than retention (only when distilled)", () => {
    const baseDir = join(testDir, "knowledge", "journal");
    const rawDir = join(baseDir, "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    const oldFile = join(rawDir, "2024-01-01.jsonl");
    writeFileSync(oldFile, event("2024-01-01T10:00:00Z") + event("2024-01-01T11:00:00Z"));
    const oldTime = new Date("2024-01-01T00:00:00Z");
    utimesSync(oldFile, oldTime, oldTime);
    const newFile = join(rawDir, "2026-05-12.jsonl");
    writeFileSync(newFile, event("2026-05-12T10:00:00Z"));

    // High-water mark: distillation has processed past the old file's events
    mkdirSync(join(baseDir, "demo"), { recursive: true });
    writeFileSync(
      join(baseDir, "demo", ".distilled-up-to.json"),
      JSON.stringify({
        last_event_ts: "2026-05-01T00:00:00Z",
        last_distilled_at: "2026-05-01T00:00:00Z",
        events_processed: 1,
      }),
    );

    const result = housekeepJournal({
      baseDir,
      projectSlug: "demo",
      retention: { raw_days: 90, mechanical_only_days: 365, narrative_days: 0, archive_cold_after_days: 365, purge_archived_after_days: 0 },
      now: new Date("2026-05-12T00:00:00Z"),
    });
    expect(result.raw_files_pruned).toBe(1);
    expect(result.raw_files_skipped_undistilled).toBe(0);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("refuses to prune raw files containing events past the high-water mark", () => {
    const baseDir = join(testDir, "knowledge", "journal");
    const rawDir = join(baseDir, "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    const oldFile = join(rawDir, "2024-01-01.jsonl");
    // File has an event from 2025-06-01 (past the high-water below)
    writeFileSync(oldFile, event("2025-06-01T10:00:00Z"));
    const oldTime = new Date("2024-01-01T00:00:00Z");
    utimesSync(oldFile, oldTime, oldTime);

    // High-water lags behind the file's event content
    mkdirSync(join(baseDir, "demo"), { recursive: true });
    writeFileSync(
      join(baseDir, "demo", ".distilled-up-to.json"),
      JSON.stringify({
        last_event_ts: "2025-01-01T00:00:00Z",
        last_distilled_at: "2025-01-01T00:00:00Z",
        events_processed: 0,
      }),
    );

    const result = housekeepJournal({
      baseDir,
      projectSlug: "demo",
      retention: { raw_days: 90, mechanical_only_days: 365, narrative_days: 0, archive_cold_after_days: 365, purge_archived_after_days: 0 },
      now: new Date("2026-05-12T00:00:00Z"),
    });
    expect(result.raw_files_pruned).toBe(0);
    expect(result.raw_files_skipped_undistilled).toBe(1);
    expect(existsSync(oldFile)).toBe(true);
  });

  it("refuses to prune any raw files when no high-water mark exists yet", () => {
    const baseDir = join(testDir, "knowledge", "journal");
    const rawDir = join(baseDir, "demo", "raw");
    mkdirSync(rawDir, { recursive: true });
    const oldFile = join(rawDir, "2024-01-01.jsonl");
    writeFileSync(oldFile, event("2024-01-01T10:00:00Z"));
    const oldTime = new Date("2024-01-01T00:00:00Z");
    utimesSync(oldFile, oldTime, oldTime);

    // NO high-water file written → nothing has been distilled → refuse to delete

    const result = housekeepJournal({
      baseDir,
      projectSlug: "demo",
      retention: { raw_days: 90, mechanical_only_days: 365, narrative_days: 0, archive_cold_after_days: 365, purge_archived_after_days: 0 },
      now: new Date("2026-05-12T00:00:00Z"),
    });
    expect(result.raw_files_pruned).toBe(0);
    expect(result.raw_files_skipped_undistilled).toBe(1);
    expect(existsSync(oldFile)).toBe(true);
  });

  it("archives cold tasks (last_active_at older than threshold)", () => {
    const baseDir = join(testDir, "knowledge", "journal");
    const taskDir = join(baseDir, "demo", "2024", "01", "01");
    mkdirSync(taskDir, { recursive: true });
    const taskPath = join(taskDir, "task-old.md");
    writeFileSync(taskPath, "---\ntask: old\n---\n\nbody");

    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();
    db.prepare(`INSERT INTO files (id, path, title, project_id, storage_type) VALUES (1, ?, 'old', 1, 'local')`).run(taskPath);
    db.prepare(`INSERT INTO journal_meta (file_id, project_id, task_slug, started_at, last_active_at, touched_files, raw_sources) VALUES (1, 1, 'old', '2024-01-01T00:00Z', '2024-01-01T00:00Z', '[]', '[]')`).run();

    const result = housekeepJournal({
      baseDir,
      projectSlug: "demo",
      retention: { raw_days: 0, mechanical_only_days: 0, narrative_days: 0, archive_cold_after_days: 365, purge_archived_after_days: 0 },
      now: new Date("2026-05-12T00:00:00Z"),
    });
    expect(result.archived_tasks).toBe(1);
    expect(existsSync(taskPath)).toBe(false);
    expect(existsSync(join(baseDir, "demo", "_archive", "task-old.md"))).toBe(true);
  });
});
