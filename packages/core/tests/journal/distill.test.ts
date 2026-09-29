// packages/core/tests/journal/distill.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { distillJournal } from "../../src/journal/distill.js";
import { ensureProjectRowForSlug } from "../../src/journal/engine.js";
import type { RawEvent } from "../../src/journal/types.js";
import { syncAgentRows, listAgents } from "../../src/hooks/registry.js";

describe("distillJournal — integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-distill-test-"));
    createDatabase(join(testDir, "test.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Demo', 'demo', '/tmp/demo')`).run();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeRaw(day: string, lines: string[]) {
    const dir = join(testDir, "knowledge", "journal", "demo", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${day}.jsonl`), lines.map((l) => l + "\n").join(""));
  }

  it("reads raw events, writes distilled markdown, advances high-water", async () => {
    writeRaw("2026-05-12", [
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "update_file", args: {}, touched: ["a.ts"], status: "ok", ms: 10 }),
      JSON.stringify({ ts: "2026-05-12T10:01:00Z", agent: "claude-code", sid: "s", event: "error", touched: ["a.ts"], msg: "boom" }),
      JSON.stringify({ ts: "2026-05-12T10:02:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "update_file", args: {}, touched: ["a.ts"], status: "ok", ms: 10 }),
    ]);

    const result = await distillJournal({
      projectSlug: "demo",
      projectId: 1,
      dataDir: testDir,
      maxEvents: 200,
      ticketRegex: /[A-Z]+-\d+/,
      openTaskWindowDays: 90,
      inFlightWindowSeconds: 0, // no buffer for test
      now: new Date("2026-05-12T11:00:00Z"),
    });

    expect(result.events_processed).toBe(3);
    expect(result.tasks_touched.length).toBeGreaterThan(0);

    const distilledRoot = join(testDir, "knowledge", "journal", "demo", "2026", "05", "12");
    const distilledFiles = readdirSync(distilledRoot);
    expect(distilledFiles.length).toBeGreaterThan(0);
    const body = readFileSync(join(distilledRoot, distilledFiles[0]), "utf8");
    expect(body).toMatch(/error-recovery/);

    // High water advanced
    const hwPath = join(testDir, "knowledge", "journal", "demo", ".distilled-up-to.json");
    expect(existsSync(hwPath)).toBe(true);
    const hw = JSON.parse(readFileSync(hwPath, "utf8"));
    expect(hw.events_processed).toBe(3);
  });

  it("is idempotent — second run with no new events does nothing", async () => {
    writeRaw("2026-05-12", [
      JSON.stringify({ ts: "2026-05-12T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "update_file", args: {}, touched: ["a.ts"], status: "ok", ms: 10 }),
    ]);
    const opts = {
      projectSlug: "demo", projectId: 1, dataDir: testDir, maxEvents: 200,
      ticketRegex: /[A-Z]+-\d+/, openTaskWindowDays: 90, inFlightWindowSeconds: 0,
      now: new Date("2026-05-12T11:00:00Z"),
    };
    await distillJournal(opts);
    const second = await distillJournal(opts);
    expect(second.events_processed).toBe(0);
  });
});

describe("distillJournal — processing the 'default' slug itself", () => {
  // Regression test for a bug found while implementing the journal
  // distillation engine (Task 4): when opts.projectSlug is itself "default",
  // rawDir(opts) and the "merged-in default dir" fallback path are the exact
  // same string, so the project-affinity filter meant only for events
  // merged in FROM "default" while distilling some OTHER slug was also
  // (incorrectly) applied to "default"'s own primary raw events. Any event
  // lacking `touched` or `args.project_id` — the common case for plain
  // tool_call events — was silently dropped, so distillJournal always
  // reported events_processed: 0 for the "default" slug even with a real
  // backlog. Fixed by only applying the affinity filter when the default
  // dir was merged in as a secondary source (i.e. projectSlug !== "default").
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kontexta-distill-default-test-"));
    createDatabase(join(testDir, "test.db"));
    const db = getDatabase();
    db.prepare(`INSERT INTO projects (id, name, slug, path) VALUES (1, 'Default (unregistered work)', 'default', NULL)`).run();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("processes a plain event with no touched/args when the slug itself is 'default'", async () => {
    const dir = join(testDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-22.jsonl"),
      JSON.stringify({ ts: "2026-07-22T10:00:00Z", agent: "claude-code", sid: "s", event: "tool_call", tool: "search", status: "ok", ms: 5 }) + "\n",
    );

    const result = await distillJournal({
      projectSlug: "default",
      projectId: 1,
      dataDir: testDir,
      maxEvents: 200,
      ticketRegex: /[A-Z]+-\d+/,
      openTaskWindowDays: 90,
      inFlightWindowSeconds: 0,
      now: new Date("2026-07-22T11:00:00Z"),
    });

    expect(result.events_processed).toBe(1);
  });
});

const SID = "16005-mugvuszf";
const NOTE_1 = "RCA: CDC bootstrap wedged because a crashed worker never released its claim; fix releases on NotFound.";
const NOTE_2 = "Implementation plan moved from repo to KB (file id 1522); canonical copy is the KB one.";
const COMMIT_SHA = "18cd2356988da7b656ac047e0b9f0a02fd26b35f";
const COMMIT_MSG = "[STRY0869745](fix) Unwedge CDC bootstrap after crashed claim";
const COMMIT_FILES = ["modules/sltdecode/src/decode_api/service.py", "modules/sltdecode/src/decode_api/service_test.py"];

// Mirrors the shape of a real captured day: 5.0.0 files.* calls record touched:[] because they address files by id.
function realShapedDay(): RawEvent[] {
  const base = { agent: "unknown", sid: SID } as const;
  return [
    { ...base, ts: "2026-09-28T07:37:22.819Z", event: "tool_call", tool: "files.create", args: { files: [{ title: "poc-architecture", content: "<truncated:2290B>", destination: "knowledge", format: "mmd" }] }, touched: [], status: "ok", ms: 195 },
    { ...base, ts: "2026-09-28T07:37:33.482Z", event: "git_context", branch: "fix/STRY0869745-cdc-bootstrap-wedge", head: "c0d4fff", project: "default" },
    { ...base, ts: "2026-09-28T07:37:33.482Z", event: "git_commit", sha: COMMIT_SHA, msg: COMMIT_MSG, files_changed: COMMIT_FILES, project: "default" },
    { ...base, ts: "2026-09-28T07:37:40.791Z", event: "tool_call", tool: "files.update", args: { id: 1519, content: "<truncated:2288B>" }, touched: [], status: "ok", ms: 171 },
    { ...base, ts: "2026-09-28T11:30:44.141Z", event: "tool_call", tool: "files.update", args: { id: 1515, content: "<truncated:6243B>", section: "2. Verified facts" }, touched: [], status: "ok", ms: 269 },
    { ...base, ts: "2026-09-28T11:54:27.729Z", event: "agent_note", summary: NOTE_1, tags: ["rca", "cdc"] },
    { ...base, ts: "2026-09-28T12:07:03.070Z", event: "tool_call", tool: "files.create", args: { files: [{ title: "impl-plan", content: "<truncated:9000B>", destination: "knowledge", kind: "dictionary" }] }, touched: [], status: "ok", ms: 210 },
    { ...base, ts: "2026-09-28T12:07:23.650Z", event: "agent_note", summary: NOTE_2 },
    { ...base, ts: "2026-09-28T12:38:33.633Z", event: "tool_call", tool: "files.search", args: { query: "bootstrap" }, touched: [], status: "ok", ms: 40 },
  ];
}

describe("distillJournal — preserves captured evidence", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "kontexta-distill-evidence-test-"));
    createDatabase(join(dataDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeRaw(slug: string, events: RawEvent[]) {
    const dir = join(dataDir, "knowledge", "journal", slug, "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-28.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  function readDistilledDay(slug: string): string {
    const dir = join(dataDir, "knowledge", "journal", slug, "2026", "09", "28");
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n=====\n");
  }

  async function run(slug: string) {
    return distillJournal({
      projectSlug: slug,
      projectId: ensureProjectRowForSlug(slug),
      dataDir,
      maxEvents: 500,
      ticketRegex: /[A-Z]+-\d+/,
      openTaskWindowDays: 90,
      inFlightWindowSeconds: 300,
      now: new Date("2026-09-29T09:00:00Z"),
      cooldownSeconds: 0,
    });
  }

  it("writes agent_note text verbatim into the distilled entry", async () => {
    writeRaw("default", realShapedDay());
    const res = await run("default");
    expect(res.events_processed).toBe(9);
    const out = readDistilledDay("default");
    expect(out).toContain(NOTE_1);
    expect(out).toContain(NOTE_2);
  });

  it("records the commit and its files_changed in body and frontmatter", async () => {
    writeRaw("default", realShapedDay());
    await run("default");
    const out = readDistilledDay("default");
    expect(out).toContain(COMMIT_SHA.slice(0, 7));
    expect(out).toContain(COMMIT_MSG);
    for (const f of COMMIT_FILES) expect(out).toContain(`  - ${f}`);
  });

  it("does not claim 'No file activity' for a window that has a commit", async () => {
    writeRaw("default", realShapedDay());
    await run("default");
    const out = readDistilledDay("default");
    const branchTask = out.split("=====").find((s) => s.includes("stry0869745"));
    expect(branchTask).toBeDefined();
    expect(branchTask).not.toContain("No file activity");
  });

  it("carries note tags into the distilled entry", async () => {
    writeRaw("default", realShapedDay());
    await run("default");
    const out = readDistilledDay("default");
    expect(out).toMatch(/\*\*Tags:\*\*.*\brca\b/);
  });

  it("does not emit a stub-only entry when notes are present", async () => {
    writeRaw("default", realShapedDay());
    await run("default");
    const out = readDistilledDay("default");
    const entries = out.split(/^## /m).filter((s) => s.trim());
    for (const e of entries) {
      if (e.includes("event(s)") && /\d+ event\(s\)/.test(e)) {
        expect(e.includes("**Notes:**") || e.includes("**Commits:**") || e.includes("**Tools:**")).toBe(true);
      }
    }
  });
});

describe("distillJournal — hook verification side-effect", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kontexta-distill-hooks-")); createDatabase(join(dataDir, "test.db")); syncAgentRows(); });
  afterEach(() => { closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });

  it("marks the agent verified the first time a source:'hook' event is distilled", async () => {
    const dir = join(dataDir, "knowledge", "journal", "default", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-29.jsonl"), [
      JSON.stringify({ ts: "2026-09-29T09:00:00.000Z", agent: "gemini", sid: "gemini:g1", event: "user_prompt", source: "hook", cwd: "/tmp", text: "hi" }),
      JSON.stringify({ ts: "2026-09-29T09:01:00.000Z", agent: "gemini", sid: "gemini:g1", event: "shell", source: "hook", cwd: "/tmp", command: "ls" }),
      JSON.stringify({ ts: "2026-09-29T09:02:00.000Z", agent: "unknown", sid: "x", event: "tool_call", tool: "files.search", source: "mcp" }),
    ].join("\n") + "\n");
    await distillJournal({ projectSlug: "default", projectId: ensureProjectRowForSlug("default"), dataDir, maxEvents: 500, ticketRegex: /[A-Z]+-\d+/, openTaskWindowDays: 90, inFlightWindowSeconds: 0, now: new Date("2026-09-29T10:00:00Z"), cooldownSeconds: 0 });
    const g = listAgents().find((r) => r.id === "gemini")!;
    expect(g.hooks_verified_at).toBe("2026-09-29T09:00:00.000Z");
    expect(g.last_hook_event_at).toBe("2026-09-29T09:01:00.000Z");
    const out = readFileSync(join(dataDir, "knowledge", "journal", "default", "2026", "09", "29", "task-0900-hi.md"), "utf8");
    expect(out).toContain("**Conversation:**");
    expect(out).toContain("09:00 you: hi");
  });
});

describe("distillJournal — task continuity across runs", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "kontexta-continuity-")); createDatabase(join(dataDir, "test.db")); });
  afterEach(() => { closeDatabase(); rmSync(dataDir, { recursive: true, force: true }); });

  const RAW = () => join(dataDir, "knowledge", "journal", "default", "raw");
  const DAY_DIR = () => join(dataDir, "knowledge", "journal", "default", "2026", "09", "28");
  const append = (events: object[]) => {
    mkdirSync(RAW(), { recursive: true });
    appendFileSync(join(RAW(), "2026-09-28.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  const run = (nowIso: string) => distillJournal({
    projectSlug: "default", projectId: ensureProjectRowForSlug("default"), dataDir, maxEvents: 500,
    ticketRegex: /[A-Z]+-\d+/, openTaskWindowDays: 90, inFlightWindowSeconds: 0, now: new Date(nowIso), cooldownSeconds: 0,
  });
  const mdFiles = () => readdirSync(DAY_DIR()).filter((f) => f.endsWith(".md")).sort();
  const base = { agent: "claude-code", sid: "s1" };

  const batch1 = () => [
    { ...base, ts: "2026-09-28T10:00:00.000Z", event: "git_context", branch: "fix/ABC-123-thing", head: "aaa" },
    { ...base, ts: "2026-09-28T10:01:00.000Z", event: "tool_call", tool: "files.update", args: {}, touched: ["/kb/a.md"], status: "ok", ms: 5 },
    { ...base, ts: "2026-09-28T10:02:00.000Z", event: "git_commit", sha: "1111111111111111111111111111111111111111", msg: "[ABC-123] first change", files_changed: ["src/a.py"] },
  ];

  it("keeps later branch-less events in the same task and accumulates files, branches and commits", async () => {
    append(batch1());
    await run("2026-09-28T10:30:00Z");
    expect(mdFiles()).toEqual(["task-ABC-123.md"]);

    append([
      { ...base, ts: "2026-09-28T11:00:00.000Z", event: "agent_note", summary: "second batch note" },
      { ...base, ts: "2026-09-28T11:01:00.000Z", event: "tool_call", tool: "files.update", args: {}, touched: ["/kb/b.md"], status: "ok", ms: 5 },
    ]);
    await run("2026-09-28T12:00:00Z");

    expect(mdFiles()).toEqual(["task-ABC-123.md"]);
    const body = readFileSync(join(DAY_DIR(), "task-ABC-123.md"), "utf8");
    expect(body).toContain("second batch note");
    expect(body).toContain("  - /kb/a.md");
    expect(body).toContain("  - /kb/b.md");
    expect(body).toContain("  branches: [fix/ABC-123-thing]");
    expect(body).toContain('msg: "[ABC-123] first change"');

    const refs = getDatabase().prepare("SELECT ref_type, ref_value FROM journal_git_refs").all() as Array<{ ref_type: string; ref_value: string }>;
    expect(refs).toContainEqual({ ref_type: "branch", ref_value: "fix/ABC-123-thing" });
    expect(refs).toContainEqual({ ref_type: "ticket", ref_value: "ABC-123" });
    expect(refs).toContainEqual({ ref_type: "commit", ref_value: "1111111111111111111111111111111111111111" });
    const hw = JSON.parse(readFileSync(join(dataDir, "knowledge", "journal", "default", ".distilled-up-to.json"), "utf8"));
    expect(hw.last_branch).toBe("fix/ABC-123-thing");
  });

  it("an event on a different branch after a run starts its own task", async () => {
    append(batch1());
    await run("2026-09-28T10:30:00Z");
    append([
      { ...base, ts: "2026-09-28T11:00:00.000Z", event: "git_context", branch: "feat/other-thing", head: "bbb" },
      { ...base, ts: "2026-09-28T11:01:00.000Z", event: "agent_note", summary: "unrelated work" },
    ]);
    await run("2026-09-28T12:00:00Z");
    expect(mdFiles()).toEqual(["task-ABC-123.md", "task-other-thing.md"]);
    expect(readFileSync(join(DAY_DIR(), "task-ABC-123.md"), "utf8")).not.toContain("unrelated work");
  });

  it("a hook event outside any git repo does not join the carried branch's task", async () => {
    append(batch1());
    await run("2026-09-28T10:30:00Z");
    append([{ agent: "claude-code", sid: "claude-code:x9", ts: "2026-09-28T11:00:00.000Z", event: "user_prompt", source: "hook", cwd: "/tmp/elsewhere", text: "not related" }]);
    await run("2026-09-28T12:00:00Z");
    expect(mdFiles()).toEqual(["task-1100-not-related.md", "task-ABC-123.md"]);
    expect(readFileSync(join(DAY_DIR(), "task-ABC-123.md"), "utf8")).not.toContain("not related");
  });

  it("range reprocesses a fixed window without reading or moving the high-water mark", async () => {
    append(batch1());
    await run("2026-09-28T10:30:00Z");
    const hwPath = join(dataDir, "knowledge", "journal", "default", ".distilled-up-to.json");
    const hwBefore = readFileSync(hwPath, "utf8");

    // Events on a later day sit outside the window and must not be touched.
    mkdirSync(RAW(), { recursive: true });
    appendFileSync(join(RAW(), "2026-09-29.jsonl"), JSON.stringify({ ...base, ts: "2026-09-29T08:00:00.000Z", event: "agent_note", summary: "later day" }) + "\n");
    rmSync(DAY_DIR(), { recursive: true, force: true });

    const res = await distillJournal({
      projectSlug: "default", projectId: ensureProjectRowForSlug("default"), dataDir, maxEvents: 500,
      ticketRegex: /[A-Z]+-\d+/, openTaskWindowDays: 90, inFlightWindowSeconds: 0, now: new Date("2026-09-29T09:00:00Z"), cooldownSeconds: 0,
      range: { since: "2026-09-28T00:00:00.000Z", until: "2026-09-29T00:00:00.000Z" },
    });

    expect(res.events_processed).toBe(3);
    expect(mdFiles()).toEqual(["task-ABC-123.md"]);
    expect(readFileSync(hwPath, "utf8")).toBe(hwBefore);
    expect(existsSync(join(dataDir, "knowledge", "journal", "default", "2026", "09", "29"))).toBe(false);
  });

  it("a branchless session keeps its readable name across runs and appends to the same file", async () => {
    const solo = { agent: "codex", sid: "codex:one" };
    append([{ ...solo, ts: "2026-09-28T08:00:00.000Z", event: "agent_note", summary: "Drafting the runbook outline" }]);
    await run("2026-09-28T08:30:00Z");
    expect(mdFiles()).toEqual(["task-0800-drafting-the-runbook-outline.md"]);

    append([{ ...solo, ts: "2026-09-28T09:00:00.000Z", event: "agent_note", summary: "Added the rollback section" }]);
    await run("2026-09-28T10:00:00Z");
    expect(mdFiles()).toEqual(["task-0800-drafting-the-runbook-outline.md"]);
    const body = readFileSync(join(DAY_DIR(), "task-0800-drafting-the-runbook-outline.md"), "utf8");
    expect(body).toContain("Drafting the runbook outline");
    expect(body).toContain("Added the rollback section");
    const hw = JSON.parse(readFileSync(join(dataDir, "knowledge", "journal", "default", ".distilled-up-to.json"), "utf8"));
    expect(hw.session_tasks).toEqual({ "codex:one": "0800-drafting-the-runbook-outline" });
  });
});
