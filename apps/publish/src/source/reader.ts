import { join } from "node:path";
import { getDataDir, listFiles, readFile, listProjectFolders, listProjectFoldersWithFiles } from "kxta-core";

/** Metadata for one vault doc (no body). */
export interface VaultDocMeta { id: number; path: string; title: string; }
/** Full vault doc (with body). */
export interface VaultDoc extends VaultDocMeta { content: string; }

/** Abstraction over the vault so render logic is testable without a DB. */
export interface VaultReader {
  listFolders(projectPath?: string): string[];
  listDocs(folder: string, projectPath?: string): VaultDocMeta[];
  read(id: number): VaultDoc;
}

/** Real reader backed by kxta-core (in-process; no MCP round-trip). */
export function createCoreReader(opts?: { projectPath?: string }): VaultReader {
  const dataDir = getDataDir();
  const projectPath = opts?.projectPath;
  const rootDir = projectPath
    ? projectPath
    : join(dataDir, "knowledge");
  return {
    listFolders: () => listProjectFoldersWithFiles(rootDir),
    listDocs: (folder) =>
      listFiles({ dataDir, filters: { folder, project_path: projectPath } })
        .filter((f) => f.path.endsWith(".md"))
        .map((f) => ({ id: f.id, path: f.path, title: f.title })),
    read: (id) => {
      const r = readFile(id);
      return { id: r.id, path: r.path, title: r.title, content: r.content };
    },
  };
}
