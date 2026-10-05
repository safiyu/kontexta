import { describe, it, expect } from "vitest";
import { splitBucketsOnPivots } from "../../src/journal/pivot.js";
import { EMBEDDING_MODEL_ID, resolveBundledModelsDir } from "../../src/inference/index.js";
import type { RawEvent, TaskBucket } from "../../src/journal/types.js";

const prompt = (ts: string, text: string): RawEvent => ({ ts: `2026-10-05T${ts}:00Z`, agent: "claude-code", sid: "s1", event: "user_prompt", text });

// Needs the bundled weights; skipped where they were not fetched (the model package is fetched at pack time).
describe.skipIf(resolveBundledModelsDir(EMBEDDING_MODEL_ID) === null)("pivot detection with the real embedding model", () => {
  const split = async (texts: string[]) => {
    const b: TaskBucket = { task_slug: "main", events: texts.map((t, i) => prompt(`10:${String(i).padStart(2, "0")}`, t)), is_new: true, matched_via: "branch" };
    return (await splitBucketsOnPivots([b]))!;
  };

  it("keeps a follow-up in the same task", async () => {
    const r = await split(["now push to the same branch and update the pr message", "keep the pr message short and to the point"]);
    expect(r.pivots).toBe(0);
  }, 60_000);

  it("splits when the subject changes", async () => {
    const r = await split(["now push to the same branch and update the pr message", "i have another question about how to call this endpoint from the command line"]);
    expect(r.pivots).toBe(1);
  }, 60_000);

  it("keeps a rephrasing of the same problem together", async () => {
    const r = await split(["how do I roll back a failed database migration", "undo the schema change that broke the orders table"]);
    expect(r.pivots).toBe(0);
  }, 60_000);
});
