export { assertPathInside, withLock } from "./util/safety.js";
export { estimateTokensFromBuffer, estimateTokensFromString } from "./util/tokens.js";
export type * from "./types.js";
export { createDatabase, getDatabase, closeDatabase } from "./db/index.js";
import { createFile, readFile, updateFile, deleteFile, listFiles, moveFile, createFolder, deleteFolder, listProjectFolders, slugify } from "./files/index.js";
export { createFile, readFile, updateFile, deleteFile, listFiles, moveFile, createFolder, deleteFolder, listProjectFolders, slugify };
export { parseOutline, findSection, replaceSection, type OutlineNode } from "./files/sections.js";
export { commitFile, getHistory, getDiff, restoreVersion, syncBackup, syncGlobalVault, getGlobalRemote, setGlobalRemote, isValidGitRemoteUrl, type SyncStage } from "./git/index.js";
export {
  addTags, removeTags, setFavorite, search, FtsQueryError,
  registerProject, unregisterProject, discoverFiles, refreshIndex, listTags, listProjects,
  findRelated, getTagsForFiles, type RelatedFileRecord,
} from "./metadata/index.js";
export { bundleSearch, type BundleFormat, type BundleOptions, type BundleResult, type BundleIncludedItem, type BundleSkippedItem } from "./bundle/index.js";
export { clipUrl, ClipError, type ClipErrorCode, type ClipUrlOptions } from "./clip/index.js";
export { createFileWatcher, type WatcherEvent } from "./watcher/index.js";
export {
  whatsNew, resolveSince,
  type WhatsNewOptions, type WhatsNewResult, type WhatsNewEntry, type ChangeKind,
} from "./whats-new/index.js";
export {
  projectMap,
  type ProjectMapOptions, type ProjectMapResult, type ProjectMapStats,
} from "./project-map/index.js";
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
