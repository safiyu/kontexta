import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { distillJournal, type DistillJournalOpts } from "../../src/journal/distill.js";
import { readJournalIntelligence } from "../../src/journal/intelligence-config.js";
import { fakeEmbed } from "./fake-embed.js";

const ON = { eventTriage: true, topicPivotDetection: true, taskCategorization: true, pivotThreshold: 0.16 };

describe("distillJournal with journal intelligence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kontexta-intel-test-"));
    createDatabase(join(dir, "test.db"));
    getDatabase().prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();
  });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  const ev = (ts: string, event: string, extra: Record<string, unknown>) => JSON.stringify({ ts: `2026-10-05T${ts}:00Z`, agent: "claude-code", sid: "s1", event, ...extra });
  function writeRaw(lines: string[]) {
    const raw = join(dir, "knowledge", "journal", "demo", "raw");
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "2026-10-05.jsonl"), lines.map((l) => l + "\n").join(""));
  }
  const run = (over: Partial<DistillJournalOpts> = {}) => distillJournal({
    projectSlug: "demo", projectId: 1, dataDir: dir, maxEvents: 500, ticketRegex: /[A-Z]+-\d+/, openTaskWindowDays: 90,
    inFlightWindowSeconds: 0, now: new Date("2026-10-06T00:00:00Z"), intelligence: ON, embed: fakeEmbed, ...over,
  });
  const taskFiles = () => {
    const d = join(dir, "knowledge", "journal", "demo", "2026", "10", "05");
    return readdirSync(d).map((f) => ({ name: f, body: readFileSync(join(d, f), "utf8") }));
  };
  const twoTopics = () => writeRaw([
    ev("10:00", "user_prompt", { text: "please fix the database migration rollback script for orders" }),
    ev("10:01", "shell", { command: "npm test" }),
    ev("10:02", "user_prompt", { text: "the database migration rollback script still fails for orders" }),
    ev("10:30", "user_prompt", { text: "descale the office coffee machine and replace its filter" }),
    ev("10:31", "shell", { command: "git status" }),
  ]);

  it("splits one session into two tasks at the topic change and remembers where it ended", async () => {
    twoTopics();
    const r = await run();
    expect(r.tasks_created).toHaveLength(2);
    const files = taskFiles();
    expect(files).toHaveLength(2);
    expect(files.some((f) => /database migration rollback/.test(f.body) && !/coffee/.test(f.body))).toBe(true);
    expect(files.some((f) => /coffee machine/.test(f.body) && !/migration rollback script/.test(f.body))).toBe(true);
    const hw = JSON.parse(readFileSync(join(dir, "knowledge", "journal", "demo", ".distilled-up-to.json"), "utf8"));
    expect(hw.session_prompts.s1).toHaveLength(2);
    expect(hw.session_tasks.s1).toBe(r.tasks_created.find((t) => /coffee/.test(t)));
  });

  it("keeps one task when topic pivot detection is switched off", async () => {
    twoTopics();
    const r = await run({ intelligence: { ...ON, topicPivotDetection: false } });
    expect(r.tasks_created).toHaveLength(1);
  });

  it("falls back to one task and says why when the embedding model is unavailable", async () => {
    twoTopics();
    const r = await run({ embed: async () => null });
    expect(r.tasks_created).toHaveLength(1);
    expect(r.warnings.join(" ")).toMatch(/topic pivot detection skipped/);
  });

  it("collapses read-only shell commands into one line, and lists everything when triage is off", async () => {
    writeRaw([
      ev("10:00", "shell", { command: "ls -la" }),
      ev("10:01", "shell", { command: "grep -n foo src/a.ts" }),
      ev("10:02", "shell", { command: "git status" }),
      ev("10:03", "shell", { command: "npm test" }),
    ]);
    await run({ intelligence: { ...ON, topicPivotDetection: false } });
    const on = taskFiles()[0].body;
    expect(on).toMatch(/read-only, not listed: .*ls × 1/);
    expect(on).toContain("`npm test`");
    expect(on).not.toContain("`ls -la`");
  });

  it("lists every command when event triage is off", async () => {
    writeRaw([ev("10:00", "shell", { command: "ls -la" }), ev("10:01", "shell", { command: "npm test" })]);
    await run({ intelligence: { ...ON, eventTriage: false, topicPivotDetection: false } });
    const body = taskFiles()[0].body;
    expect(body).toContain("`ls -la`");
    expect(body).not.toContain("not listed");
  });

  it("omits the category when task categorization is off", async () => {
    writeRaw([ev("10:00", "user_prompt", { text: "fix the crash in the parser please" })]);
    await run({ intelligence: { ...ON, topicPivotDetection: false, taskCategorization: false } });
    expect(taskFiles()[0].body).not.toMatch(/^category:/m);
  });
});

describe("readJournalIntelligence", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-intel-cfg-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = (decision_engine: unknown) => writeFileSync(join(dir, "kontexta.json"), JSON.stringify({ journal: { distillation: { decision_engine } } }));

  it("defaults every switch to on", () => {
    expect(readJournalIntelligence(dir)).toEqual(ON);
  });
  it("turns individual switches off", () => {
    cfg({ topic_pivot_detection: false });
    expect(readJournalIntelligence(dir)).toEqual({ ...ON, topicPivotDetection: false });
  });
  it("turns everything off with enabled: false", () => {
    cfg({ enabled: false });
    expect(readJournalIntelligence(dir)).toEqual({ eventTriage: false, topicPivotDetection: false, taskCategorization: false, pivotThreshold: 0.16 });
  });
  it("reads pivot_threshold and keeps it within a sane range", () => {
    cfg({ pivot_threshold: 0.3 });
    expect(readJournalIntelligence(dir).pivotThreshold).toBe(0.3);
    cfg({ pivot_threshold: 5 });
    expect(readJournalIntelligence(dir).pivotThreshold).toBe(0.5);
    cfg({ pivot_threshold: "high" });
    expect(readJournalIntelligence(dir).pivotThreshold).toBe(0.16);
  });
  it("ignores an unreadable config", () => {
    writeFileSync(join(dir, "kontexta.json"), "{ not json");
    expect(readJournalIntelligence(dir)).toEqual(ON);
  });
});
