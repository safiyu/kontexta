// packages/core/src/journal/renderer.ts
import type { RawEvent } from "./types.js";
import { runPatterns } from "./patterns/index.js";

export interface RenderInput {
  task_slug: string;
  events: RawEvent[];
  now: string; // ISO ts of the entry header
}

export function renderMechanicalEntry(input: RenderInput): string {
  const { events, now } = input;
  const patterns = runPatterns(events);
  const ts = `${now.slice(0, 10)} ${now.slice(11, 16)}`;

  const filesUnique = [...new Set(events.flatMap((e) => e.touched ?? []))];
  const allTags = patterns.flatMap((p) => p.tags);
  const dedupedTags = [...new Set([...allTags, "mechanical"])];

  if (patterns.length === 0) {
    return [
      `## ${ts} — auto-summary (mechanical)`,
      ``,
      `Activity in this window:`,
      `- ${events.length} event(s)`,
      filesUnique.length > 0 ? `- Touched files: ${filesUnique.join(", ")}` : `- No file activity`,
      ``,
      `_Mechanical summary — no recognised pattern detected._`,
      ``,
      filesUnique.length > 0 ? `**Touched:** ${filesUnique.join(", ")}` : ``,
      `**Tags:** ${dedupedTags.join(", ")}`,
      ``,
    ].filter((l) => l !== "").join("\n");
  }

  const headSummary = patterns[0].summary;
  const lines: string[] = [];
  lines.push(`## ${ts} — ${headSummary} (mechanical)`);
  lines.push(``);
  for (const p of patterns) {
    lines.push(`**Pattern:** ${p.name}`);
    for (const d of p.details) lines.push(`- ${d}`);
    lines.push(``);
  }
  if (filesUnique.length > 0) lines.push(`**Touched:** ${filesUnique.join(", ")}`);
  lines.push(`**Tags:** ${dedupedTags.join(", ")}`);
  lines.push(``);
  return lines.join("\n");
}
