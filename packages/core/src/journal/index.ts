// packages/core/src/journal/index.ts
export * from "./types.js";
export { JournalWriter } from "./writer.js";
export type { JournalWriterOptions } from "./writer.js";
export { redactArgs, defaultRedactConfig } from "./redact.js";
export type { RedactConfig } from "./redact.js";
export { readHighWater, writeHighWater } from "./high-water.js";
export type { HighWater } from "./high-water.js";
export { groupEventsIntoTasks, extractTicketId } from "./topic-detector.js";
export { runPatterns, builtinPatterns } from "./patterns/index.js";
export type { PatternMatch, PatternDetector, ExtraPatternDef } from "./patterns/index.js";
export { loadExtraPatterns } from "./patterns/extra-loader.js";
export { renderMechanicalEntry } from "./renderer.js";
export type { RenderInput } from "./renderer.js";
export {
  upsertJournalMeta, journalMetaForFile, openTasksForProject, journalRefsByValue, markUpgradeApplied,
} from "./repository.js";
export type { UpsertJournalMetaInput, JournalMetaRow } from "./repository.js";
export { distillJournal } from "./distill.js";
export type { DistillJournalOpts } from "./distill.js";
export { checkGit } from "./git-watcher.js";
export type { GitWatcherState } from "./git-watcher.js";
export { acquireCooldown, releaseCooldown } from "./cooldown.js";
export { isMcpActive } from "./presence.js";
export { housekeepJournal } from "./housekeep.js";
export type { HousekeepConfig, HousekeepResult } from "./housekeep.js";
export { isReadOnlyTool, shouldBlock, backlogErrorPayload } from "./strict-mode.js";
