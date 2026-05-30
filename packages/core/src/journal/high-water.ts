import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface HighWater {
  last_event_ts: string;
  last_distilled_at: string;
  events_processed: number;
}

function pathFor(baseDir: string, projectSlug: string): string {
  return join(baseDir, projectSlug, ".distilled-up-to.json");
}

export function readHighWater(baseDir: string, projectSlug: string): HighWater | null {
  const p = pathFor(baseDir, projectSlug);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.last_event_ts !== "string") return null;
    return parsed;
  } catch (e) {
    console.warn(`[journal/high-water] malformed mark at ${p}, ignoring`, e);
    return null;
  }
}

export function writeHighWater(baseDir: string, projectSlug: string, hw: HighWater): void {
  const dir = join(baseDir, projectSlug);
  mkdirSync(dir, { recursive: true });
  const final = pathFor(baseDir, projectSlug);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(hw, null, 2));
  renameSync(tmp, final);
}
