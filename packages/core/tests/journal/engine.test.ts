// packages/core/tests/journal/engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { listSlugsWithBacklog, ensureProjectRowForSlug } from "../../src/journal/engine.js";

describe("listSlugsWithBacklog", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function journalRoot() {
    return join(testDir, "knowledge", "journal");
  }

  function writeRaw(slug: string, file: string, mtime: Date) {
    const dir = join(journalRoot(), slug, "raw");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, file);
    writeFileSync(p, JSON.stringify({ ts: mtime.toISOString(), agent: "x", sid: "x", event: "tool_call" }) + "\n");
    utimesSync(p, mtime, mtime);
  }

  function writeHighWater(slug: string, mtime: Date) {
    const dir = join(journalRoot(), slug);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, ".distilled-up-to.json");
    writeFileSync(p, JSON.stringify({ last_event_ts: mtime.toISOString(), last_distilled_at: mtime.toISOString(), events_processed: 1 }));
    utimesSync(p, mtime, mtime);
  }

  it("returns [] when the journal root does not exist", () => {
    expect(listSlugsWithBacklog(testDir)).toEqual([]);
  });

  it("returns a slug with raw events and no high-water file", () => {
    writeRaw("default", "2026-07-22.jsonl", new Date("2026-07-22T10:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual(["default"]);
  });

  it("skips a slug whose high-water file is newer than all raw files", () => {
    writeRaw("clean-slug", "2026-07-22.jsonl", new Date("2026-07-22T10:00:00Z"));
    writeHighWater("clean-slug", new Date("2026-07-22T11:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual([]);
  });

  it("includes a slug whose raw file is newer than its high-water file", () => {
    writeHighWater("stale-slug", new Date("2026-07-22T09:00:00Z"));
    writeRaw("stale-slug", "2026-07-22.jsonl", new Date("2026-07-22T10:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual(["stale-slug"]);
  });

  it("skips a slug with a raw/ dir but no .jsonl files", () => {
    mkdirSync(join(journalRoot(), "empty-slug", "raw"), { recursive: true });
    expect(listSlugsWithBacklog(testDir)).toEqual([]);
  });

  it("sorts dirty slugs by newest raw mtime, descending", () => {
    writeRaw("older", "a.jsonl", new Date("2026-07-20T10:00:00Z"));
    writeRaw("newer", "a.jsonl", new Date("2026-07-22T10:00:00Z"));
    expect(listSlugsWithBacklog(testDir)).toEqual(["newer", "older"]);
  });
});

describe("ensureProjectRowForSlug", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-provision-test-"));
    createDatabase(join(testDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a synthetic project row with path NULL for an unknown slug", () => {
    const id = ensureProjectRowForSlug("default");
    const db = getDatabase();
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    expect(row.slug).toBe("default");
    expect(row.path).toBeNull();
    expect(row.name).toBe("Default (unregistered work)");
    expect(row.description).toMatch(/orphan slug 'default'/);
  });

  it("derives a titlecased name for non-default slugs", () => {
    const id = ensureProjectRowForSlug("scratch-notes");
    const db = getDatabase();
    const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as any;
    expect(row.name).toBe("Scratch Notes");
  });

  it("is idempotent — calling twice returns the same id", () => {
    const first = ensureProjectRowForSlug("default");
    const second = ensureProjectRowForSlug("default");
    expect(second).toBe(first);
    const db = getDatabase();
    const count = db.prepare("SELECT COUNT(*) AS c FROM projects WHERE slug = ?").get("default") as any;
    expect(count.c).toBe(1);
  });

  it("suffixes the name when it collides with an existing registered project", () => {
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (name, slug, path) VALUES (?, ?, ?)`).run("Scratch", "some-other-slug", "/tmp/scratch");
    const id = ensureProjectRowForSlug("scratch");
    const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as any;
    expect(row.name).toBe("Scratch (auto)");
  });

  it("returns the existing id when a project is already registered for that slug", () => {
    const db = getDatabase();
    const result = db.prepare(`INSERT INTO projects (name, slug, path) VALUES (?, ?, ?)`).run("Demo", "demo", "/tmp/demo");
    const existingId = Number(result.lastInsertRowid);
    const id = ensureProjectRowForSlug("demo");
    expect(id).toBe(existingId);
  });
});
