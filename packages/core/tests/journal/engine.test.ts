// packages/core/tests/journal/engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { listSlugsWithBacklog, ensureProjectRowForSlug, startDistillEngine } from "../../src/journal/engine.js";

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

function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() - start > timeoutMs) return rejectPromise(new Error("waitFor: timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("startDistillEngine — tick behavior", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-tick-test-"));
    createDatabase(join(testDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeRawEvent(slug: string, ts: string) {
    const dir = join(testDir, "knowledge", "journal", slug, "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${ts.slice(0, 10)}.jsonl`),
      JSON.stringify({ ts, agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }) + "\n",
    );
  }

  it("distills a dirty slug and provisions a synthetic project", async () => {
    writeRawEvent("default", "2026-07-22T10:00:00Z");

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      const result = await engine.tickNow();
      expect(result.slugs_considered).toBe(1);
      expect(result.slugs_distilled).toBe(1);
      expect(result.slugs_failed).toBe(0);

      const db = getDatabase();
      const project = db.prepare("SELECT * FROM projects WHERE slug = ?").get("default") as any;
      expect(project).toBeDefined();
      expect(project.path).toBeNull();

      const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
      expect(existsSync(distilledRoot)).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("skips a slug with no backlog", async () => {
    const engine = startDistillEngine({ dataDir: testDir, drainOnStart: false });
    try {
      const result = await engine.tickNow();
      expect(result.slugs_considered).toBe(0);
      expect(result.slugs_distilled).toBe(0);
    } finally {
      await engine.stop();
    }
  });

  it("does not let one failing slug block the next", async () => {
    writeRawEvent("default", "2026-07-22T10:00:00Z");
    writeRawEvent("also-dirty", "2026-07-22T10:00:00Z");

    // Force distillJournal to throw for "default" only: pre-create a regular
    // file where it needs to mkdir a YYYY directory, so mkdirSync(recursive)
    // fails with ENOTDIR. "also-dirty" is untouched and should still succeed.
    const sabotagedPath = join(testDir, "knowledge", "journal", "default", "2026");
    writeFileSync(sabotagedPath, "not a directory");

    const errors: Array<{ slug: string }> = [];
    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
      onError: (_err, slug) => errors.push({ slug }),
    });
    try {
      const result = await engine.tickNow();
      expect(result.slugs_considered).toBe(2);
      expect(result.slugs_distilled).toBe(1);
      expect(result.slugs_failed).toBe(1);
      expect(errors.map((e) => e.slug)).toEqual(["default"]);
    } finally {
      await engine.stop();
    }
  });
});

describe("startDistillEngine — lifecycle", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-engine-lifecycle-test-"));
    createDatabase(join(testDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("drains on start when drainOnStart is true (default)", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      tickMs: 60_000,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
      await waitFor(() => existsSync(distilledRoot));
      expect(existsSync(distilledRoot)).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("does not drain on start when drainOnStart is false", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call" }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      tickMs: 60_000,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
      expect(existsSync(distilledRoot)).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("stop({flush:true}) awaits one final tick", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call" }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      tickMs: 60_000,
      drainOnStart: false,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    await engine.stop({ flush: true });
    const distilledRoot = join(testDir, "knowledge", "journal", "default", "2026", "07", "22");
    expect(existsSync(distilledRoot)).toBe(true);
  });

  it("stop() is idempotent", async () => {
    const engine = startDistillEngine({ dataDir: testDir, drainOnStart: false, tickMs: 60_000 });
    await engine.stop();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it("tickNow() collapses overlapping calls into one in-flight promise", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call" }) + "\n",
    );

    const engine = startDistillEngine({
      dataDir: testDir,
      drainOnStart: false,
      tickMs: 60_000,
      now: () => new Date("2026-07-22T10:10:00Z"),
    });
    try {
      const [a, b] = await Promise.all([engine.tickNow(), engine.tickNow()]);
      expect(a).toBe(b);
    } finally {
      await engine.stop();
    }
  });
});
