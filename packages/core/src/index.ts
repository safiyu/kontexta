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
