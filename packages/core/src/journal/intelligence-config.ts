import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PIVOT_THRESHOLD } from "./pivot.js";

export interface JournalIntelligence {
  eventTriage: boolean;
  topicPivotDetection: boolean;
  taskCategorization: boolean;
  /** Prompts less similar than this to the last two prompts start a new task; lower splits less. */
  pivotThreshold: number;
}

/** Reads journal.distillation.decision_engine from <dataDir>/kontexta.json; every switch defaults to on. */
export function readJournalIntelligence(dataDir: string): JournalIntelligence {
  let cfg: any = {};
  try {
    const p = join(dataDir, "kontexta.json");
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch { /* unreadable config means defaults */ }
  const d = cfg?.journal?.distillation?.decision_engine ?? {};
  const on = d.enabled !== false;
  return {
    eventTriage: on && d.event_triage !== false,
    topicPivotDetection: on && d.topic_pivot_detection !== false,
    taskCategorization: on && d.task_categorization !== false,
    pivotThreshold: typeof d.pivot_threshold === "number" && Number.isFinite(d.pivot_threshold) ? Math.min(0.5, Math.max(0.05, d.pivot_threshold)) : PIVOT_THRESHOLD,
  };
}
