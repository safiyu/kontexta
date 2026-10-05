// packages/core/tests/bundle-rerank.test.ts
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { bundleSearch } from "../src/bundle/index.js";
import { inferenceRuntime } from "../src/inference/runtime.js";
import type { ModelSession } from "../src/inference/runtime.js";

let TEST_DATA_DIR: string;
let TEST_DB_PATH: string;
let sessionSpy: ReturnType<typeof vi.spyOn>;

function seedFile(opts: {
  id: number;
  title: string;
  path: string;
  content: string;
  content_class?: string | null;
  project_id?: number | null;
}) {
  writeFileSync(opts.path, opts.content);
  const db = getDatabase();
  db.prepare(
    `INSERT INTO files (id, path, title, project_id, storage_type, content_class, source_path, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local', ?, NULL, NULL, datetime('now'), datetime('now'))`
  ).run(opts.id, opts.path, opts.title, opts.project_id ?? null, opts.content_class ?? null);
  // Mirror FTS row
  db.prepare(
    `INSERT INTO fts_index (rowid, title, content) VALUES (?, ?, ?)`
  ).run(opts.id, opts.title, opts.content);
}

/**
 * A fake cross-encoder that satisfies the shape the RerankEngine consumes
 * (an object with `tokenizer` and `model`). Logits are derived from the
 * passage content so results are deterministic without a real model:
 * passages mentioning "maxclients" score high, everything else scores low.
 */
function makeFakeCrossEncoder(): { tokenizer: unknown; model: unknown } {
  let lastLogits: number[] = [];
  const tokenizer = (_queries: string[], opts: { text_pair?: string[] }) => {
    const passages = (opts.text_pair ?? []) as string[];
    lastLogits = passages.map((p) => (p.toLowerCase().includes("maxclients") ? 4 : -8));
    return { input_ids: [] };
  };
  const model = async () => ({ logits: { data: lastLogits } });
  return { tokenizer, model };
}

/** Build a full ModelSession with the given (fake) model instance. */
function fakeSession(instance: unknown): ModelSession {
  return {
    config: { modelId: "Xenova/ms-marco-MiniLM-L-6-v2", device: "cpu", timeoutMs: 300 },
    device: "cpu",
    cacheDir: TEST_DATA_DIR,
    loadedAt: Date.now(),
    memoryRssBytes: 0,
    instance,
  } as ModelSession;
}

beforeEach(() => {
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "kontexta-bundle-rerank-"));
  TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");
  mkdirSync(join(TEST_DATA_DIR, "knowledge"), { recursive: true });
  createDatabase(TEST_DB_PATH);
  // Intercept model loading so no real model is ever fetched.
  sessionSpy = vi.spyOn(inferenceRuntime, "getModelSession");
});

afterEach(() => {
  sessionSpy.mockRestore();
  closeDatabase();
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("bundleSearch with neural reranking", () => {
  test("preserves legacy BM25/SQL dictionary-first order when rerank is false", async () => {
    const dictPath = join(TEST_DATA_DIR, "knowledge", "dict.md");
    const notePath = join(TEST_DATA_DIR, "knowledge", "note.md");

    // Dictionary file has low semantic match but is content_class = 'dictionary'
    seedFile({
      id: 1,
      title: "Generic Glossary",
      path: dictPath,
      content: "Redis terminology glossary definition and terms.",
      content_class: "dictionary",
    });

    seedFile({
      id: 2,
      title: "Specific Incident Trace",
      path: notePath,
      content: "Redis connection timeout root cause analysis and fix.",
      content_class: "note",
    });

    // Without rerank: dictionary wins unconditionally in SQL (no model involved).
    const res = await bundleSearch({ query: "Redis" }, { rerank: false });
    expect(res.meta.included[0].id).toBe(1);
  });

  test("applies two-stage neural reranking and annotates rerank_score when rerank is true", async () => {
    const dictPath = join(TEST_DATA_DIR, "knowledge", "dict.md");
    const notePath = join(TEST_DATA_DIR, "knowledge", "note.md");

    // Note has an exact specific match to the timeout problem.
    seedFile({
      id: 1,
      title: "Generic Redis Configuration",
      path: dictPath,
      content: "General redis configuration parameters, default ports, and cluster settings.",
      content_class: "dictionary",
    });

    seedFile({
      id: 2,
      title: "Postmortem: Redis Connection Timeout in Staging",
      path: notePath,
      content: "Incident report: redis connection timeout during staging deployment due to maxclients limit.",
      content_class: "note",
    });

    // Fake model: the timeout-related passage (note) scores high, the
    // generic dict scores low — so the incident note should outrank the dict
    // even after the dictionary content-class boost.
    sessionSpy.mockResolvedValue(fakeSession(makeFakeCrossEncoder()));

    const res = await bundleSearch({ query: "redis" }, { rerank: true });

    expect(res.meta.included.length).toBeGreaterThan(0);
    // rerank_score is populated from the (arbitrated) final_score.
    expect(res.meta.included[0].rerank_score).toBeDefined();
    // And intent is routed (heuristic — no model needed).
    expect(res.meta.intent).toBeDefined();
    // The specific incident note (id 2) beats the generic config (id 1).
    expect(res.meta.included[0].id).toBe(2);
    // The low-scoring dict is pruned below the relevance floor and reported as skipped.
    expect(res.meta.included.map((i) => i.id)).not.toContain(1);
    expect(res.meta.skipped.some((s) => s.id === 1 && s.reason === "below_relevance_threshold")).toBe(true);
  });

  test("falls back to raw BM25 ordering (no rerank_score) when the model is unavailable", async () => {
    const dictPath = join(TEST_DATA_DIR, "knowledge", "dict.md");
    const notePath = join(TEST_DATA_DIR, "knowledge", "note.md");

    seedFile({
      id: 1,
      title: "Generic Redis Configuration",
      path: dictPath,
      content: "General redis configuration parameters and defaults.",
      content_class: "dictionary",
    });
    seedFile({
      id: 2,
      title: "Postmortem: Redis Connection Timeout",
      path: notePath,
      content: "Incident report: redis connection timeout during deployment.",
      content_class: "note",
    });

    // Model fails to load -> engine returns null -> bundle keeps raw BM25 order.
    sessionSpy.mockResolvedValue(fakeSession(null));

    const res = await bundleSearch({ query: "redis" }, { rerank: true });

    // Still returns results (graceful degradation), but no model scores are attached.
    expect(res.meta.included.length).toBeGreaterThan(0);
    for (const item of res.meta.included) {
      expect(item.rerank_score).toBeUndefined();
    }
  });

  test("populates sufficiency metadata when check_sufficiency is enabled", async () => {
    const notePath = join(TEST_DATA_DIR, "knowledge", "note.md");
    seedFile({
      id: 1,
      title: "Redis Timeout Postmortem",
      path: notePath,
      content: "Detailed explanation of connection timeout fix.",
      content_class: "note",
    });

    sessionSpy.mockResolvedValue(fakeSession(makeFakeCrossEncoder()));

    const res = await bundleSearch(
      { query: "redis connection timeout" },
      { rerank: true, check_sufficiency: true }
    );

    // Decision engine short-circuits without a model -> deterministic verdict.
    expect(res.meta.sufficiency).toBeDefined();
    expect(typeof res.meta.sufficiency?.satisfied).toBe("boolean");
  });
});
