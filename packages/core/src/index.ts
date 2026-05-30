export { createDatabase, getDatabase, closeDatabase, gracefulShutdown } from "./db/index.js";
import { createFile, readFile, updateFile, deleteFile, listFiles, moveFile, createFolder, deleteFolder, listProjectFolders, slugify } from "./files/index.js";
export { createFile, readFile, updateFile, deleteFile, listFiles, moveFile, createFolder, deleteFolder, listProjectFolders, slugify };
export { parseOutline, findSection, replaceSection, type OutlineNode } from "./files/sections.js";
export { assertPathInside } from "./util/safety.js";
export { INDEXED_EXTENSIONS, isIndexedFile, stripIndexedExt } from "./util/extensions.js";
export type { IndexedExt } from "./util/extensions.js";
export {
  addTags, removeTags, setFavorite, search, FtsQueryError,
  registerProject, unregisterProject, discoverFiles, refreshIndex, listTags, listProjects,
  findRelated, getTagsForFiles, type RelatedFileRecord,
} from "./metadata/index.js";
export { commitFile, getHistory, getDiff, restoreVersion, syncBackup, syncGlobalVault, getGlobalRemote, setGlobalRemote, isValidGitRemoteUrl, type SyncStage } from "./git/index.js";
export { withLock, track, inFlightCount, isShuttingDown, setShuttingDown, awaitDrain } from "./util/safety.js";
export {
  RULE_BLOCK_VERSION,
  RULES_BLOCK_BODY,
  SCAFFOLDS,
  detectAgentContextFiles,
  parseMarker,
  injectOrUpdate,
  syncAgentRules,
  checkAgentRulesStatus,
  InjectError,
  type AgentId,
  type ParseResult,
  type InjectResult,
  type SyncOpts,
  type SyncResult,
  type SyncResultEntry,
  type SyncSkippedEntry,
} from "./agent-rules/index.js";
export { createFileWatcher, type WatcherEvent } from "./watcher/index.js";
export { bundleSearch, type BundleFormat, type BundleOptions, type BundleResult, type BundleIncludedItem, type BundleSkippedItem } from "./bundle/index.js";
export { estimateTokensFromBuffer, estimateTokensFromString } from "./util/tokens.js";
export type * from "./types.js";
export { clipUrl, ClipError, type ClipErrorCode, type ClipUrlOptions } from "./clip/index.js";
export {
  whatsNew, resolveSince,
  type WhatsNewOptions, type WhatsNewResult, type WhatsNewEntry, type ChangeKind,
} from "./whats-new/index.js";
export {
  projectMap,
  type ProjectMapOptions, type ProjectMapResult, type ProjectMapStats,
} from "./project-map/index.js";
export { migrateEnvVars } from "./compat/env-shim.js";
export { migrateDataFiles, migrateProjectConfig } from "./compat/file-migration.js";
export * from "./journal/index.js";
