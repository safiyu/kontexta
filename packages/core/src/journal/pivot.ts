// Topic-pivot detection: a person's prompt that is semantically far from their last two prompts starts a new task.
// Threshold chosen on 109 hand-labelled prompt pairs from real journals (held-out F1 about 0.7); replies, file overlap and nearest-neighbour matching scored no better.
import type { RawEvent, TaskBucket } from "./types.js";
import { embedTexts, cosineSimilarity, meanVector, type EmbedFn } from "../inference/embeddings.js";
import { isHumanPrompt } from "./event-triage.js";
import { labelFor, hhmm } from "./topic-detector.js";

export const PIVOT_THRESHOLD = 0.16;
const CONTEXT_PROMPTS = 2;
const EMBED_CHARS = 400;
const SEED_CHARS = 300;
const MIN_WORDS = 4;

export function isTopicPrompt(text: string | undefined): text is string {
  return isHumanPrompt(text) && text!.trim().split(/\s+/).length >= MIN_WORDS;
}

export interface PivotOptions {
  embed?: EmbedFn;
  /** Last prompts per session from the previous run, so a pivot on a batch boundary is still seen. */
  seeds?: Record<string, string[]>;
  threshold?: number;
}

export interface PivotSplit {
  buckets: TaskBucket[];
  /** Session id to the task its latest events now belong to, for sessions that pivoted. */
  sessions: Record<string, string>;
  /** Last prompts per session seen in this batch. */
  seeds: Record<string, string[]>;
  pivots: number;
}

const sidOf = (e: RawEvent): string | null => (e.sid && e.sid !== "unknown" ? e.sid : null);
const clip = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Splits buckets where a session changes topic. Returns null when the embedding model is unavailable. */
export async function splitBucketsOnPivots(buckets: TaskBucket[], opts: PivotOptions = {}): Promise<PivotSplit | null> {
  const embed = opts.embed ?? embedTexts;
  const threshold = opts.threshold ?? PIVOT_THRESHOLD;

  const bySid = new Map<string, RawEvent[]>();
  for (const b of buckets) for (const e of b.events) {
    const sid = sidOf(e);
    if (sid && e.event === "user_prompt" && isTopicPrompt(e.text)) (bySid.get(sid) ?? bySid.set(sid, []).get(sid)!).push(e);
  }
  if (bySid.size === 0) return { buckets, sessions: {}, seeds: {}, pivots: 0 };
  for (const prompts of bySid.values()) prompts.sort((a, b) => a.ts.localeCompare(b.ts));

  const texts: string[] = [];
  const plan = [...bySid].map(([sid, prompts]) => {
    const seedTexts = (opts.seeds?.[sid] ?? []).map((t) => clip(t, EMBED_CHARS));
    return { sid, prompts, seedCount: seedTexts.length, first: texts.length, items: [...seedTexts, ...prompts.map((p) => clip(p.text!, EMBED_CHARS))] };
  });
  for (const p of plan) texts.push(...p.items);
  const vectors = await embed(texts);
  if (!vectors || vectors.length !== texts.length) return null;

  const pivotEvents = new Set<RawEvent>();
  const seeds: Record<string, string[]> = {};
  for (const p of plan) {
    const vecs = vectors.slice(p.first, p.first + p.items.length);
    for (let i = Math.max(1, p.seedCount); i < vecs.length; i++) {
      const context = meanVector(vecs.slice(Math.max(0, i - CONTEXT_PROMPTS), i));
      if (cosineSimilarity(context, vecs[i]) < threshold) pivotEvents.add(p.prompts[i - p.seedCount]);
    }
    seeds[p.sid] = p.items.slice(-CONTEXT_PROMPTS).map((t) => clip(t, SEED_CHARS));
  }
  if (pivotEvents.size === 0) return { buckets, sessions: {}, seeds, pivots: 0 };

  const taken = new Set(buckets.map((b) => b.task_slug));
  const out: TaskBucket[] = [];
  const segmentOf = new Map<string, { slug: string; last: string }>();
  for (const b of buckets) {
    const stay: RawEvent[] = [];
    const segments = new Map<string, RawEvent[]>();
    const counters = new Map<string, number>();
    for (const e of b.events) {
      const sid = sidOf(e);
      if (sid && pivotEvents.has(e)) counters.set(sid, (counters.get(sid) ?? 0) + 1);
      const n = sid ? counters.get(sid) ?? 0 : 0;
      if (n === 0) stay.push(e);
      else (segments.get(`${sid}#${n}`) ?? segments.set(`${sid}#${n}`, []).get(`${sid}#${n}`)!).push(e);
    }
    if (stay.length > 0) out.push({ ...b, events: stay });
    for (const [key, events] of segments) {
      const base = `${hhmm(events[0].ts)}-${labelFor(events)}`;
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      taken.add(slug);
      out.push({ task_slug: slug, events, is_new: true, matched_via: "minted", branches: b.branches });
      const sid = key.slice(0, key.lastIndexOf("#"));
      const last = events[events.length - 1].ts;
      const prev = segmentOf.get(sid);
      if (!prev || last >= prev.last) segmentOf.set(sid, { slug, last });
    }
  }
  const sessions: Record<string, string> = {};
  for (const [sid, seg] of segmentOf) sessions[sid] = seg.slug;
  return { buckets: out, sessions, seeds, pivots: pivotEvents.size };
}
