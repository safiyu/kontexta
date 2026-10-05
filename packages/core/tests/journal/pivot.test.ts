import { describe, it, expect, vi } from "vitest";
import { splitBucketsOnPivots, isTopicPrompt } from "../../src/journal/pivot.js";
import type { RawEvent, TaskBucket } from "../../src/journal/types.js";
import { fakeEmbed } from "./fake-embed.js";

const prompt = (ts: string, sid: string, text: string): RawEvent => ({ ts: `2026-10-05T${ts}:00Z`, agent: "claude-code", sid, event: "user_prompt", text });
const shell = (ts: string, sid: string, command: string): RawEvent => ({ ts: `2026-10-05T${ts}:00Z`, agent: "claude-code", sid, event: "shell", command });
const bucket = (events: RawEvent[], extra: Partial<TaskBucket> = {}): TaskBucket => ({ task_slug: "main", events, is_new: true, matched_via: "branch", branches: ["main"], ...extra });

const DB_A = "please fix the database migration rollback script for orders";
const DB_B = "the database migration rollback script still fails for orders";
const COFFEE = "descale the office coffee machine and replace its filter";

describe("isTopicPrompt", () => {
  it("accepts typed prompts of four or more words only", () => {
    expect(isTopicPrompt("fix the login bug")).toBe(true);
    expect(isTopicPrompt("yes do it")).toBe(false);
    expect(isTopicPrompt("<task-notification> something happened here today")).toBe(false);
    expect(isTopicPrompt(undefined)).toBe(false);
  });
});

describe("splitBucketsOnPivots", () => {
  it("does nothing, and never loads a model, when no session has typed prompts", async () => {
    const embed = vi.fn(fakeEmbed);
    const b = bucket([shell("10:00", "s1", "ls")]);
    const r = await splitBucketsOnPivots([b], { embed });
    expect(r).toMatchObject({ pivots: 0, buckets: [b] });
    expect(embed).not.toHaveBeenCalled();
  });

  it("keeps a task whole while the topic stays the same, and remembers the last two prompts", async () => {
    const b = bucket([prompt("10:00", "s1", DB_A), shell("10:01", "s1", "npm test"), prompt("10:02", "s1", DB_B)]);
    const r = (await splitBucketsOnPivots([b], { embed: fakeEmbed }))!;
    expect(r.pivots).toBe(0);
    expect(r.buckets).toEqual([b]);
    expect(r.seeds.s1).toEqual([DB_A, DB_B]);
  });

  it("starts a new task at the prompt that changes topic, leaving earlier events behind", async () => {
    const before = [prompt("10:00", "s1", DB_A), shell("10:01", "s1", "npm test"), prompt("10:02", "s1", DB_B)];
    const after = [prompt("10:30", "s1", COFFEE), shell("10:31", "s1", "ls")];
    const r = (await splitBucketsOnPivots([bucket([...before, ...after])], { embed: fakeEmbed }))!;
    expect(r.pivots).toBe(1);
    expect(r.buckets).toHaveLength(2);
    expect(r.buckets[0]).toMatchObject({ task_slug: "main", events: before });
    expect(r.buckets[1]).toMatchObject({ is_new: true, matched_via: "minted", events: after, branches: ["main"] });
    expect(r.buckets[1].task_slug).toMatch(/^1030-descale-the-office-coffee/);
    expect(r.sessions.s1).toBe(r.buckets[1].task_slug);
  });

  it("only moves the session that pivoted when two sessions share a task", async () => {
    const a = [prompt("10:00", "s1", DB_A), prompt("10:10", "s1", COFFEE)];
    const other = [prompt("10:05", "s2", DB_B), shell("10:20", "s2", "npm test")];
    const r = (await splitBucketsOnPivots([bucket([...a, ...other].sort((x, y) => x.ts.localeCompare(y.ts)))], { embed: fakeEmbed }))!;
    expect(r.pivots).toBe(1);
    const stay = r.buckets.find((b) => b.task_slug === "main")!;
    expect(stay.events.filter((e) => e.sid === "s2")).toHaveLength(2);
    expect(stay.events.filter((e) => e.sid === "s1")).toHaveLength(1);
    expect(r.buckets.find((b) => b.task_slug !== "main")!.events.every((e) => e.sid === "s1")).toBe(true);
  });

  it("compares the first prompt of a batch with the prompts remembered from the last run", async () => {
    const b = bucket([prompt("11:00", "s1", COFFEE), shell("11:01", "s1", "ls")]);
    const r = (await splitBucketsOnPivots([b], { embed: fakeEmbed, seeds: { s1: [DB_A, DB_B] } }))!;
    expect(r.pivots).toBe(1);
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0].task_slug).not.toBe("main");
    expect(r.buckets[0].events).toEqual(b.events);
  });

  it("ignores system messages and one-line acknowledgements", async () => {
    const b = bucket([prompt("10:00", "s1", DB_A), prompt("10:01", "s1", "<task-notification> unrelated coffee machine descale"), prompt("10:02", "s1", "ok thanks"), prompt("10:03", "s1", DB_B)]);
    expect((await splitBucketsOnPivots([b], { embed: fakeEmbed }))!.pivots).toBe(0);
  });

  it("gives a new task a unique name when the natural one is taken", async () => {
    const events = [prompt("10:00", "s1", DB_A), prompt("10:30", "s1", COFFEE)];
    const taken = bucket([prompt("09:00", "s9", "unrelated words only here")], { task_slug: "1030-descale-the-office-coffee-machine-and" });
    const r = (await splitBucketsOnPivots([bucket(events), taken], { embed: fakeEmbed }))!;
    const slugs = r.buckets.map((b) => b.task_slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("returns null when the embedding model is unavailable", async () => {
    const b = bucket([prompt("10:00", "s1", DB_A), prompt("10:30", "s1", COFFEE)]);
    expect(await splitBucketsOnPivots([b], { embed: async () => null })).toBeNull();
  });
});
