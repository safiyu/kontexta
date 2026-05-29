export { assertPathInside, withLock } from "./util/safety.js";
export { estimateTokensFromBuffer, estimateTokensFromString } from "./util/tokens.js";
export type * from "./types.js";
export { createDatabase, getDatabase, closeDatabase } from "./db/index.js";
import { createFile, readFile, updateFile, deleteFile, listFiles, moveFile, createFolder, deleteFolder, listProjectFolders, slugify } from "./files/index.js";
export { createFile, readFile, updateFile, deleteFile, listFiles, moveFile, createFolder, deleteFolder, listProjectFolders, slugify };
export { parseOutline, findSection, replaceSection, type OutlineNode } from "./files/sections.js";
export { commitFile, getHistory, getDiff, restoreVersion, syncBackup, syncGlobalVault, getGlobalRemote, setGlobalRemote, isValidGitRemoteUrl, type SyncStage } from "./git/index.js";
