import type { PatternDetector } from "./index.js";
import type { RawEvent } from "../types.js";

export interface ExtraPatternDef {
  name: string;
  match: {
    tag_any?: string[];
    tag_all?: string[];
    tool_any?: string[];
    min_events?: number;
    max_events?: number;
  };
}

export function loadExtraPatterns(defs: ExtraPatternDef[] | null | undefined): PatternDetector[] {
  if (!Array.isArray(defs)) return [];
  const out: PatternDetector[] = [];
  for (const def of defs) {
    if (!def || typeof def.name !== "string" || !def.match) {
      console.warn("[journal/extra-loader] skipping malformed extra pattern", def);
      continue;
    }
    out.push(compile(def));
  }
  return out;
}

function compile(def: ExtraPatternDef): PatternDetector {
  return {
    name: def.name,
    detect(events: RawEvent[]) {
      const matched = events.filter((ev) => matches(ev, def.match));
      if (def.match.min_events !== undefined && matched.length < def.match.min_events) return null;
      if (def.match.max_events !== undefined && matched.length > def.match.max_events) return null;
      if (matched.length === 0) return null;
      return {
        name: def.name,
        summary: `${def.name}: ${matched.length} matching event(s)`,
        details: [`custom pattern '${def.name}' matched ${matched.length} event(s)`],
        tags: [def.name],
      };
    },
  };
}

function matches(ev: RawEvent, m: ExtraPatternDef["match"]): boolean {
  const evTags = new Set(ev.tags ?? []);
  if (m.tag_any && !m.tag_any.some((t) => evTags.has(t))) return false;
  if (m.tag_all && !m.tag_all.every((t) => evTags.has(t))) return false;
  if (m.tool_any && !m.tool_any.includes(ev.tool ?? "")) return false;
  return true;
}
