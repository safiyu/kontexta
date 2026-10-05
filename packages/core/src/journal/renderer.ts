// packages/core/src/journal/renderer.ts
import type { RawEvent } from "./types.js";
import { runPatterns } from "./patterns/index.js";
import { gradeEvent, commandVerbs } from "./event-triage.js";
import type { ExtraPatternDef } from "./patterns/extra-loader.js";

export interface RenderInput {
  task_slug: string;
  events: RawEvent[];
  now: string; // ISO ts of the entry header
  extraPatterns?: ExtraPatternDef[];
  /** List read-only shell commands as a one-line tally instead of one line each. */
  collapseNoise?: boolean;
}

export function touchedFilesOf(events: RawEvent[]): string[] {
  return [...new Set(events.flatMap((e) => [...(e.touched ?? []), ...(e.files_changed ?? [])]))];
}

function hhmm(ts: string): string {
  return ts.slice(11, 16);
}

function fmtText(e: RawEvent): string {
  const t = (e.text ?? "").replace(/\s+/g, " ").trim();
  return e.truncated ? `${t} …(truncated, ${e.bytes} bytes)` : t;
}

// Conversation, shell, notes, commits and the tool tally are the raw evidence; they render regardless of pattern match so distillation never loses what was said or run.
function renderEvidence(events: RawEvent[], collapseNoise: boolean): string[] {
  const lines: string[] = [];
  const conv = events.filter((e) => e.event === "user_prompt" || e.event === "agent_reply" || e.event === "agent_question");
  if (conv.length > 0) {
    lines.push(`**Conversation:**`);
    for (const e of conv) {
      if (e.event === "user_prompt") lines.push(`- ${hhmm(e.ts)} you: ${fmtText(e)}`);
      else if (e.event === "agent_reply") lines.push(`- ${hhmm(e.ts)} agent${e.subagent ? " (subagent)" : ""}: ${fmtText(e)}`);
      else for (const q of e.questions ?? []) lines.push(`- ${hhmm(e.ts)} agent asked: ${q.question}${q.answer !== undefined ? ` — ${q.answer}` : " — (no answer recorded)"}`);
    }
    lines.push(``);
  }
  const shell = new Map<string, number>();
  const quiet = new Map<string, number>();
  for (const e of events) {
    if (e.event !== "shell" || !e.command) continue;
    if (collapseNoise && gradeEvent(e).grade === 0) {
      const verbs = commandVerbs(e.command);
      for (const v of verbs.length > 0 ? verbs : ["cd"]) quiet.set(v, (quiet.get(v) ?? 0) + 1);
    } else shell.set(e.command, (shell.get(e.command) ?? 0) + 1);
  }
  if (shell.size > 0 || quiet.size > 0) {
    lines.push(`**Shell:**`);
    for (const [cmd, n] of shell) lines.push(n > 1 ? `- \`${cmd}\` × ${n}` : `- \`${cmd}\``);
    if (quiet.size > 0) lines.push(`- read-only, not listed: ${[...quiet].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} × ${n}`).join(", ")}`);
    lines.push(``);
  }
  const notes =events.filter((e) => (e.event === "agent_note" || e.event === "user_intent") && e.summary);
  if (notes.length > 0) {
    lines.push(`**Notes:**`);
    for (const n of notes) lines.push(`- ${hhmm(n.ts)} ${n.summary}`);
    lines.push(``);
  }
  const commits = events.filter((e) => e.event === "git_commit" && e.sha);
  if (commits.length > 0) {
    lines.push(`**Commits:**`);
    for (const c of commits) lines.push(`- ${c.sha!.slice(0, 7)} ${c.msg ?? ""}`.trimEnd());
    lines.push(``);
  }
  const tally = new Map<string, number>();
  for (const e of events) if (e.event === "tool_call" && e.tool) tally.set(e.tool, (tally.get(e.tool) ?? 0) + 1);
  if (tally.size > 0) {
    const parts = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} × ${n}`);
    lines.push(`**Tools:** ${parts.join(", ")}`);
    lines.push(``);
  }
  return lines;
}

export function renderMechanicalEntry(input: RenderInput): string {
  const { events, now } = input;
  const patterns = runPatterns(events, input.extraPatterns ?? []);
  const ts = `${now.slice(0, 10)} ${now.slice(11, 16)}`;

  const filesUnique = touchedFilesOf(events);
  const noteTags = events.flatMap((e) => (e.event === "agent_note" || e.event === "user_intent") ? (e.tags ?? []) : []);
  const allTags = patterns.flatMap((p) => p.tags);
  const convTag = events.some((e) => e.event === "user_prompt") ? ["conversation"] : [];
  const dedupedTags = [...new Set([...allTags, ...noteTags, ...convTag, "mechanical"])];
  const evidence = renderEvidence(events, input.collapseNoise ?? false);

  if (patterns.length === 0) {
    return [
      `## ${ts} — auto-summary (mechanical)`,
      ``,
      `Activity in this window:`,
      `- ${events.length} event(s)`,
      filesUnique.length > 0 ? `- Touched files: ${filesUnique.join(", ")}` : `- No file activity`,
      ``,
      ...evidence,
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
  lines.push(...evidence);
  if (filesUnique.length > 0) lines.push(`**Touched:** ${filesUnique.join(", ")}`);
  lines.push(`**Tags:** ${dedupedTags.join(", ")}`);
  lines.push(``);
  return lines.join("\n");
}
