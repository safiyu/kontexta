import { join } from "node:path";
import { getDataDir, listFiles, readFile, listProjectFolders } from "kxta-core";

/** Metadata for one vault doc (no body). */
export interface VaultDocMeta { id: number; path: string; title: string; }
/** Full vault doc (with body). */
export interface VaultDoc extends VaultDocMeta { content: string; }

/** Abstraction over the vault so render logic is testable without a DB. */
export interface VaultReader {
  listFolders(): string[];
  listDocs(folder: string): VaultDocMeta[];
  read(id: number): VaultDoc;
}

/** Real reader backed by kxta-core (in-process; no MCP round-trip). */
export function createCoreReader(): VaultReader {
  const dataDir = getDataDir();
  const knowledgeDir = join(dataDir, "knowledge");
  return {
    listFolders: () => listProjectFolders(knowledgeDir),
    listDocs: (folder) =>
      listFiles({ dataDir, filters: { folder } })
        .filter((f) => f.path.endsWith(".md"))
        .map((f) => ({ id: f.id, path: f.path, title: f.title })),
    read: (id) => {
      const r = readFile(id);
      return { id: r.id, path: r.path, title: r.title, content: r.content };
    },
  };
}
