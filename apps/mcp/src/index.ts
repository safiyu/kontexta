#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createDatabase,
  createFile,
  readFile,
  updateFile,
  deleteFile,
  listFiles,
  addTags,
  removeTags,
  setFavorite,
  search,
  FtsQueryError,
  registerProject,
  unregisterProject,
  discoverFiles,
  refreshIndex,
  listTags,
  listProjects,
  syncBackup,
  bundleSearch,
  estimateTokensFromBuffer,
  clipUrl,
  ClipError,
  getHistory,
  getDiff,
  getDatabase,
  findRelated,
  whatsNew,
  projectMap,
  getTagsForFiles,
  restoreVersion,
  parseOutline,
  findSection,
  replaceSection,
  listProjectFolders,
  createFolder,
  deleteFolder,
  moveFile,
  withLock,
  detectAgentContextFiles,
  syncAgentRules,
  checkAgentRulesStatus,
  RULE_BLOCK_VERSION,
  gracefulShutdown,
  type AgentId,
} from "kxta-core";
import RE2 from "re2";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";
import os from "node:os";
import { statSync, lstatSync, openSync, readSync, closeSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HandsRegistry } from "./hands/registry.js";
import { buildSchemaDoc } from "./hands/schema-doc.js";
import { formatExecResult } from "./hands/formatter.js";
import { killAllActiveChildren } from "./hands/executor.js";
import { initCapture, shutdownCapture, wrapHandler, startGitPoller } from "./journal-capture.js";
import { registerJournalTools } from "./journal-tools.js";
import { registerCommitUpgradesTool } from "./journal-commit-upgrades-tool.js";
import { registerHousekeepTool } from "./journal-housekeep-tool.js";
import { getDataDir } from "kxta-core";

const dataDir = getDataDir();

const PROJECT_TOKEN_WARN_THRESHOLD = Number(
  process.env.KONTEXTA_PROJECT_TOKEN_WARN ?? 100_000
);

function getAgentRulesWarning(projectId?: number | null): string | null {
  try {
    const db = getDatabase();
    let projects: any[] = [];
    if (projectId === null) return null; // KB only
    if (typeof projectId === "number") {
      const p = db.prepare("SELECT id, path, name FROM projects WHERE id = ?").get(projectId);
      if (p) projects = [p];
    } else {
      projects = db.prepare("SELECT id, path, name FROM projects").all();
    }

    const outdatedProjects: string[] = [];
    for (const p of projects) {
      if (!p || !p.path || !existsSync(p.path)) continue;
      const contextFiles = detectAgentContextFiles(p.path);
      if (contextFiles.length === 0) continue;
      const statuses = checkAgentRulesStatus(p.path, contextFiles);
      if (statuses.some((s) => !s.upToDate)) {
        outdatedProjects.push(p.name);
      }
    }

    if (outdatedProjects.length === 0) return null;
    if (outdatedProjects.length === 1) {
      return `Project "${outdatedProjects[0]}" has outdated agent rules (v${RULE_BLOCK_VERSION} available). Run onboard_agent to update.`;
    }
    return `${outdatedProjects.length} projects have outdated agent rules (v${RULE_BLOCK_VERSION} available). Run onboard_agent for each to update.`;
  } catch (e) {
    console.error("Error checking agent rules status:", e);
    return null;
  }
}
function tokenWarning(total: number): string | null {
  if (!Number.isFinite(PROJECT_TOKEN_WARN_THRESHOLD) || PROJECT_TOKEN_WARN_THRESHOLD <= 0) return null;
  if (total <= PROJECT_TOKEN_WARN_THRESHOLD) return null;
  return (
    `Project content totals ~${total.toLocaleString()} tokens, above the ` +
    `${PROJECT_TOKEN_WARN_THRESHOLD.toLocaleString()}-token soft cap. ` +
    `Consider narrowing scope (folder/tag filters), adding ignore patterns ` +
    `(e.g. node_modules-style build/cache dirs), or using bundle_search with a ` +
    `max_tokens budget instead of pulling the full set into one prompt.`
  );
}

function estimateTokensFromFile(filePath: string, sizeBytes: number): number {
  if (sizeBytes <= 0) return 1;
  const sampleSize = Math.min(4096, sizeBytes);
  if (sampleSize < 256) return Math.max(1, Math.ceil(sizeBytes / 4));
  let mostlyAscii = true;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(sampleSize);
    readSync(fd, buf, 0, sampleSize, 0);
    mostlyAscii = buf.toString("utf-8").length > sampleSize * 0.7;
  } catch {} finally {
    if (fd !== null) try { closeSync(fd); } catch {}
  }
  return Math.max(1, Math.ceil(sizeBytes / (mostlyAscii ? 4 : 3)));
}

function annotateTokens<T extends { path?: string; content?: string }>(rec: T): T & { size_bytes: number | null; est_tokens: number | null } {
  let size_bytes: number | null = null;
  let est_tokens: number | null = null;
  if (typeof rec.content === "string") {
    const buf = Buffer.from(rec.content, "utf-8");
    size_bytes = buf.length;
    est_tokens = estimateTokensFromBuffer(buf);
  } else if (rec.path) {
    try {
      size_bytes = statSync(rec.path).size;
      est_tokens = estimateTokensFromFile(rec.path, size_bytes);
    } catch {}
  }
  return { ...rec, size_bytes, est_tokens };
}

function attachTags<T extends { id: number }>(records: T[]): (T & { tags: string[] })[] {
  if (records.length === 0) return [];
  const tagMap = getTagsForFiles(records.map((r) => r.id));
  return records.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] }));
}

// Robust runtime version loading: walks up directories to find package.json
let pkgVersion = "0.0.0";
let pkgVersionFound = false;
try {
  let currentDir = dirname(fileURLToPath(import.meta.url));
  while (currentDir !== dirname(currentDir)) {
    const p = join(currentDir, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (pkg.name === "kontexta-mcp" && pkg.version) {
        pkgVersion = pkg.version;
        pkgVersionFound = true;
        break;
      }
    }
    currentDir = dirname(currentDir);
  }
} catch (e) {
  console.warn(`Failed to read package.json for version: ${(e as Error).message}. Defaulting to 0.0.0`);
}
if (!pkgVersionFound) {
  console.warn("Could not locate kontexta-mcp package.json by walking up from module dir; defaulting version to 0.0.0");
}

const server = new McpServer({
  name: "kontexta",
  version: pkgVersion,
});

const handsRegistry = new HandsRegistry(server);

// Initialize journal capture for auto-wrapping all tool calls
const baseJournalDir = join(dataDir, "knowledge", "journal");
const projectSlug = process.env.KONTEXTA_DEFAULT_PROJECT_SLUG ?? "default";
const agent = process.env.KONTEXTA_AGENT ?? "unknown";
const sid = `${process.pid}-${Date.now().toString(36)}`;
initCapture({ projectSlug, baseDir: baseJournalDir, agent, sid });

startGitPoller(process.env.KONTEXTA_PROJECT_PATH ?? process.cwd(), 30);
process.on("exit", shutdownCapture);
// Signal-handler ordering: kill detached Hands children FIRST so their
// process groups receive SIGTERM before this process exits and orphans
// them. shutdownCapture flushes the journal; then drain in-flight ops and close DB.
async function handleShutdownSignal(signal: string) {
  console.warn(`[kontexta-mcp] received ${signal}; draining…`);
  killAllActiveChildren("SIGTERM");
  shutdownCapture();
  try {
    const remaining = await gracefulShutdown(10_000);
    if (remaining > 0) {
      console.warn(`[kontexta-mcp] drain timeout; ${remaining} ops still in-flight at exit`);
    }
  } catch (err) {
    console.warn(`[kontexta-mcp] gracefulShutdown failed`, err);
  }
  process.exit(0);
}
let _shutdownInFlight = false;
process.on("SIGINT", () => { if (!_shutdownInFlight) { _shutdownInFlight = true; void handleShutdownSignal("SIGINT"); } });
process.on("SIGTERM", () => { if (!_shutdownInFlight) { _shutdownInFlight = true; void handleShutdownSignal("SIGTERM"); } });

// Auto-wrap every tool registration that follows. journal_append (legacy) is excluded
// because it will be removed in Task 15. Auto-wrap covers all current and future tools.
const _origServerTool = server.tool.bind(server);
(server as any).tool = function (name: string, ...rest: any[]): any {
  if (name === "journal_append") {
    return (_origServerTool as any)(name, ...rest);
  }
  const handler = rest[rest.length - 1];
  if (typeof handler === "function") {
    rest[rest.length - 1] = wrapHandler(name, handler);
  }
  return (_origServerTool as any)(name, ...rest);
};

// Legacy journal_append tool — excluded from wrapHandler (line 223) so it
// does NOT get the journal-backlog envelope injected. Kept for backward-compat.
server.tool(
  "journal_append",
  "Append a timestamped text entry to today's daily journal file in the Knowledge Base. Creates the file if it doesn't already exist. Both calls on the same calendar day return the same file_id. Returns { file_id }.",
  {
    text: z.string().describe("Text to append to today's journal entry"),
    project_id: z.number().optional().describe("Optional project ID context"),
  },
  async ({ text }: { text: string; project_id?: number }) => {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const journalFolder = "journal";
      const title = `journal-${today}`;
      const db = getDatabase();

      // Try to find an existing journal file for today.
      const knowledgeDir = join(dataDir, "knowledge");
      const expectedPath = join(knowledgeDir, journalFolder, `${title}.md`);
      const existingRow = db
        .prepare("SELECT id, path FROM files WHERE path = ? AND project_id IS NULL")
        .get(expectedPath) as { id: number; path: string } | undefined;

      if (existingRow) {
        // Append to existing file.
        const existing = readFile(existingRow.id);
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        const newContent = `${existing.content}\n---\n**${timestamp}** ${text}\n`;
        await updateFile(existingRow.id, newContent, dataDir);
        return {
          content: [{ type: "text", text: JSON.stringify({ file_id: existingRow.id }, null, 2) }],
        };
      } else {
        // Create a new daily journal file.
        const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        const content = `# Journal — ${today}\n\n---\n**${timestamp}** ${text}\n`;
        const result = await createFile({
          title,
          content,
          destination: "knowledge",
          folder: journalFolder,
          dataDir,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ file_id: result.id }, null, 2) }],
        };
      }
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "create_file",
  "Create a new markdown or mermaid file in the knowledge base or project. This operation writes a new file to disk and adds it to the local SQLite FTS5 index. Destination can be 'knowledge' (global KB), 'project' (reference file inside a project repo), or 'kontexta' (internal Kontexta schema file). If destination is 'project' or 'kontexta', project_id is strictly required. No external auth required. Rate limits do not apply (local operation). Returns the created file metadata including its new ID, path, and estimated tokens. If the destination directory does not exist, it will be created automatically. Use this tool to instantiate new contextual documents or notes. To modify an existing file, use 'update_file' instead. Parameters: 'destination' dictates required fields; if 'project' or 'kontexta', 'project_id' must be a valid integer. 'tags' and 'folder' are optional. Pass format='mmd' to create a Mermaid diagram file (.mmd); defaults to 'md'.",
  {
    title: z.string().describe("Title of the file"),
    content: z.string().describe("Content of the file"),
    destination: z.enum(["knowledge", "project", "kontexta"]).describe("Destination type"),
    project_id: z.number().optional().describe("Project ID (required for project/kontexta destinations)"),
    folder: z.string().optional().describe("Optional folder path"),
    tags: z.array(z.string()).optional().describe("Optional array of tags"),
    format: z.enum(["md", "mmd"]).optional().describe("File extension to write. Defaults to 'md'."),
  },
  async ({ title, content, destination, project_id, folder, tags, format }) => {
    const result = await createFile({
      title,
      content,
      destination,
      projectId: project_id,
      folder,
      tags,
      dataDir,
      format,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(annotateTokens(result), null, 2) }],
    };
  }
);

server.tool(
  "read_file",
  "Read one file's full body and metadata by ID. Read-only; no side effects, auth, or rate limits. Returns title, path, content, tags, est_tokens (so you can budget context before opening more files), and timestamps. Throws if the ID is unknown. Use for a single known file. Prefer `describe_file` to inspect without paying body tokens; `read_files` for batches; `read_file_lines`/`read_section` for partial reads; `read_file_by_path` when you only have the absolute path.",
  {
    id: z.number().describe("File ID"),
  },
  async ({ id }) => {
    const result = readFile(id);
    return {
      content: [{ type: "text", text: JSON.stringify(annotateTokens(result), null, 2) }],
    };
  }
);

server.tool(
  "read_files",
  "Batch read up to 200 files by ID in one call. Returns per-file annotated records, an aggregate `total_est_tokens`, and an isolated `errors[]` (one bad ID does NOT abort the batch). Read-only; no side effects, auth, or rate limits. Use instead of looping `read_file` to halve round-trips and get the combined token cost upfront. For >200 IDs, page yourself.",
  {
    ids: z.array(z.number()).min(1).max(200).describe("File IDs to read (max 200 per call)"),
  },
  async ({ ids }) => {
    const files: any[] = [];
    const errors: { id: number; error: string }[] = [];
    let total_est_tokens = 0;
    for (const id of ids) {
      try {
        const r = annotateTokens(readFile(id));
        files.push(r);
        total_est_tokens += r.est_tokens ?? 0;
      } catch (e: any) {
        errors.push({ id, error: e?.message ?? String(e) });
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ files, total_est_tokens, error_count: errors.length, errors }, null, 2) }],
    };
  }
);

server.tool(
  "describe_file",
  "Return everything ABOUT a file without pulling its content (no token cost from the body). Tags, size, est_tokens, history depth, related-file ids, backlinks, project, folder, last edited. Operates locally with no auth or rate limits. Use this when you'd otherwise chain read_file + list_tags + get_history + find_related just to decide whether to actually read the file. Parameters: 'id' must be a valid integer file ID.",
  {
    id: z.number().describe("File ID"),
  },
  async ({ id }) => {
    try {
      const db = getDatabase();
      const file = db
        .prepare("SELECT * FROM files WHERE id = ?")
        .get(id) as any;
      if (!file) throw new Error(`File not found: ${id}`);

      const tags = (db
        .prepare(
          `SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = ? ORDER BY t.name`
        )
        .all(id) as { name: string }[]).map((r) => r.name);

      const favorite = !!db.prepare("SELECT 1 FROM favorites WHERE file_id = ?").get(id);

      let projectName: string | null = null;
      let folder: string | null = null;
      if (file.project_id) {
        const project = db
          .prepare("SELECT name, path FROM projects WHERE id = ?")
          .get(file.project_id) as { name: string; path: string | null } | undefined;
        projectName = project?.name ?? null;
        if (project?.path && file.path?.startsWith(project.path)) {
          const rel = file.path.slice(project.path.length).replace(/^[\/\\]+/, "");
          const parts = rel.split(/[\/\\]/);
          folder = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
        }
      } else {
        const knowledgeRoot = join(dataDir, "knowledge");
        if (file.path?.startsWith(knowledgeRoot)) {
          const rel = file.path.slice(knowledgeRoot.length).replace(/^[\/\\]+/, "");
          const parts = rel.split(/[\/\\]/);
          folder = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
        }
      }

      let size_bytes: number | null = null;
      let est_tokens: number | null = null;
      try {
        size_bytes = statSync(file.path).size;
        est_tokens = Math.max(1, Math.ceil(size_bytes / 4));
      } catch {}

      let history_count = 0;
      try {
        const hist = await getHistory(repoDirForFile(file), file.path);
        history_count = hist.length;
      } catch {}

      let related: { id: number; shared_tag_count: number }[] = [];
      try {
        related = findRelated(id, 10).map((r) => ({ id: r.id, shared_tag_count: r.shared_tag_count }));
      } catch {}

      const basenameWithExt = file.path.split(/[/\\]/).pop() ?? "";
      const basename = basenameWithExt.replace(/\.md$/, "");
      let backlinks: { id: number; title: string; path: string }[] = [];
      if (basename && basenameWithExt) {
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const linkPatterns = [
          new RegExp(`\\]\\([^)]*${escapeRegex(basenameWithExt)}(?:[#?][^)]*)?\\)`),
          new RegExp(`\\[\\[\\s*${escapeRegex(basename)}\\s*(?:\\|[^\\]]+)?\\]\\]`, "i"),
          new RegExp(`(?:^|[^\\w/-])${escapeRegex(basenameWithExt)}(?:[^\\w]|$)`),
        ];
        try {
          const escFts = basename.replace(/"/g, '""');
          const ftsQuery = `"${escFts} md" OR ${escFts}`;
          const candidates = db
            .prepare(
              `SELECT files.id, files.title, files.path
               FROM fts_index
               JOIN files ON files.id = fts_index.rowid
               WHERE fts_index MATCH ? AND files.id != ?
               LIMIT 200`
            )
            .all(ftsQuery, id) as { id: number; title: string; path: string }[];
          for (const c of candidates) {
            try {
              const content = readFileSync(c.path, "utf8");
              if (linkPatterns.some((re) => re.test(content))) {
                backlinks.push(c);
                if (backlinks.length >= 50) break;
              }
            } catch {}
          }
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: file.id,
                path: file.path,
                title: file.title,
                project_id: file.project_id,
                project_name: projectName,
                folder,
                storage_type: file.storage_type,
                tags,
                favorite,
                size_bytes,
                est_tokens,
                created_at: file.created_at,
                updated_at: file.updated_at,
                history_count,
                related,
                backlinks,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "read_file_lines",
  "Return a 1-indexed inclusive line slice of a file. Out-of-range bounds clamp silently to the file's actual length; `to < from` throws. Read-only; no side effects, auth, or rate limits. Returns the snippet plus its size_bytes and est_tokens. Use to inspect a stack-trace region or a chunk of a large file without pulling the whole body. Prefer `read_section` if you know the heading, `grep_in_file` if you know a pattern but not the line number.",
  {
    id: z.number().describe("File ID"),
    from: z.number().int().positive().describe("First line (1-indexed, inclusive)"),
    to: z.number().int().positive().describe("Last line (1-indexed, inclusive)"),
  },
  async ({ id, from, to }) => {
    try {
      if (to < from) throw new Error("`to` must be >= `from`");
      const file = readFile(id);
      const lines = file.content.split("\n");
      const start = Math.max(0, from - 1);
      const end = Math.min(lines.length, to);
      const slice = lines.slice(start, end).join("\n");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_id: id,
                path: file.path,
                from: start + 1,
                to: end,
                total_lines: lines.length,
                content: slice,
                size_bytes: Buffer.byteLength(slice, "utf8"),
                est_tokens: estimateTokensFromBuffer(Buffer.from(slice, "utf8")),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "grep_in_file",
  "Match a JS regex against one file's lines and return matched lines with line numbers (capped: default 100, max 500). Catches what FTS misses: URLs, hyphenated terms, code identifiers. Read-only; no side effects, auth, or rate limits. Invalid regex throws `invalid regex`. Returns `{matches, match_count, truncated}`. Use after `read_file_outline` when you know the file but need a specific reference; for cross-file regex use `regex_search`; for keyword/concept search use `search`.",
  {
    id: z.number().describe("File ID"),
    pattern: z.string().describe("Pattern to match. Treated as a JavaScript RegExp source."),
    case_insensitive: z.boolean().optional().describe("Add the 'i' flag (default false)"),
    max_matches: z.number().int().positive().max(500).optional().describe("Cap on returned hits (default 100)"),
  },
  async ({ id, pattern, case_insensitive, max_matches }) => {
    try {
      let re: RE2;
      try {
        re = new RE2(pattern, case_insensitive ? "i" : "");
      } catch (e: any) {
        throw new Error(`invalid regex: ${e?.message ?? e}`);
      }
      const file = readFile(id);
      const lines = file.content.split("\n");
      const cap = max_matches ?? 100;
      const matches: { line: number; text: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({ line: i + 1, text: lines[i] });
          if (matches.length >= cap) break;
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_id: id,
                path: file.path,
                pattern,
                match_count: matches.length,
                truncated: matches.length === cap,
                matches,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "regex_search",
  "Match a JS regex against the body of every file in scope (project, KB, or all) and return per-file hits with line numbers. Slower than FTS `search` because it reads each file's content; use only when FTS misses substrings, URLs, or code identifiers. Read-only; no side effects, auth, or rate limits. Capped at 500 files / 10 hits per file by default; the response reports `files_truncated` and per-file truncation so the agent can re-scope. `project_id: null` = KB only; omit = everywhere. Invalid regex throws.",
  {
    pattern: z.string().describe("JavaScript RegExp source"),
    project_id: z.number().nullable().optional().describe("Scope to one project, null for KB-only, omit for everything"),
    case_insensitive: z.boolean().optional(),
    max_files: z.number().int().positive().max(2000).optional().describe("Cap on files scanned (default 500)"),
    max_matches_per_file: z.number().int().positive().max(100).optional().describe("Per-file hit cap (default 10)"),
  },
  async ({ pattern, project_id, case_insensitive, max_files, max_matches_per_file }) => {
    try {
      let re: RE2;
      try {
        re = new RE2(pattern, case_insensitive ? "i" : "");
      } catch (e: any) {
        throw new Error(`invalid regex: ${e?.message ?? e}`);
      }
      const fileCap = max_files ?? 500;
      const perFileCap = max_matches_per_file ?? 10;
      const db = getDatabase();

      let where = "";
      const params: any[] = [];
      if (project_id === null) {
        where = "WHERE project_id IS NULL";
      } else if (typeof project_id === "number") {
        where = "WHERE project_id = ?";
        params.push(project_id);
      }
      const rows = db
        .prepare(`SELECT id, path, title FROM files ${where} LIMIT ?`)
        .all(...params, fileCap) as { id: number; path: string; title: string }[];

      const hits: any[] = [];
      let scanned = 0;
      for (const r of rows) {
        scanned++;
        let content: string;
        try { content = readFileSync(r.path, "utf8"); } catch { continue; }
        const lines = content.split("\n");
        const fileHits: { line: number; text: string }[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            fileHits.push({ line: i + 1, text: lines[i] });
            if (fileHits.length >= perFileCap) break;
          }
        }
        if (fileHits.length > 0) {
          hits.push({ file_id: r.id, path: r.path, title: r.title, match_count: fileHits.length, matches: fileHits });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                pattern,
                files_scanned: scanned,
                files_truncated: rows.length === fileCap,
                file_hit_count: hits.length,
                total_match_count: hits.reduce((s, h) => s + h.match_count, 0),
                hits,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "update_file",
  "Update the entire content of an existing file by its ID. This replaces the file's content on disk and triggers an FTS5 re-index. Returns the updated file metadata including new estimated token counts. Operates locally with no external auth or rate limits. If you only need to modify a single section without replacing the entire file, use 'update_file_section' instead to save context budget. Parameters: 'id' must be a valid integer file ID. 'content' is the complete markdown string that will replace the file.",
  {
    id: z.number().describe("File ID"),
    content: z.string().describe("New content"),
  },
  async ({ id, content }) => {
    const result = await updateFile(id, content, dataDir);
    return {
      content: [{ type: "text", text: JSON.stringify(annotateTokens(result), null, 2) }],
    };
  }
);

server.tool(
  "delete_file",
  "DESTRUCTIVE. Permanently delete one file by ID. KB files are unlinked from disk AND removed from the FTS5 index; project reference files only have their index entry removed (the file on disk is left alone so the watcher does not fight your editor). Not idempotent — deleting an unknown ID throws. No external auth or rate limits. Returns `{success: true}`. Use only when the file is truly obsolete; to deprioritise without losing data, untag (`remove_tags`) or unfavorite (`set_favorite`) instead. Bulk variant: `delete_files`.",
  {
    id: z.number().describe("File ID"),
  },
  async ({ id }) => {
    deleteFile(id, dataDir);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
    };
  }
);

server.tool(
  "list_files",
  "List file metadata with optional filters (project_id, tag, favorite, folder, untagged) and pagination. Read-only; no side effects, auth, or rate limits. Each row is annotated with tags, est_tokens, and size_bytes; the response includes `total_est_tokens` so you can budget before reading bodies. `project_id: null` returns ONLY Knowledge Base files; omit the field to span everything. Use to browse known structure; for keyword/content lookup use `search`; for a denser whole-vault dump use `project_map`.",
  {
    project_id: z.number().nullable().optional().describe("Filter by project ID. Pass null to list ONLY Knowledge Base files (project_id IS NULL)."),
    tag: z.string().optional().describe("Filter by tag name"),
    favorite: z.boolean().optional().describe("Filter by favorite status"),
    folder: z.string().optional().describe("Filter by folder path"),
    untagged: z.boolean().optional().describe("If true, return only files that have no tags. Useful for bulk-tagging workflows."),
    limit: z.number().optional().describe("Maximum number of results"),
    offset: z.number().optional().describe("Offset for pagination"),
  },
  async ({ project_id, tag, favorite, folder, untagged, limit, offset }) => {
    const filters: any = {};
    if (project_id !== undefined) filters.project_id = project_id;
    if (tag !== undefined) filters.tag = tag;
    if (favorite !== undefined) filters.favorite = favorite;
    if (folder !== undefined) filters.folder = folder;
    if (untagged !== undefined) filters.untagged = untagged;
    if (limit !== undefined) filters.limit = limit;
    if (offset !== undefined) filters.offset = offset;

    const result = listFiles({ dataDir, filters });
    const annotated = attachTags(result.map(annotateTokens));
    const total_est_tokens = annotated.reduce((s, f) => s + (f.est_tokens ?? 0), 0);
    return {
      content: [{ type: "text", text: JSON.stringify({ files: annotated, total_est_tokens }, null, 2) }],
    };
  }
);

server.tool(
  "search",
  "Full-text (SQLite FTS5) keyword search across files. Returns ranked matches with inline match_excerpt and title_highlight (no follow-up `read_file` needed for snippets) plus tags, est_tokens, size_bytes, and aggregate `total_est_tokens`. Read-only; no side effects, auth, or rate limits. FTS is tokenised: it WILL miss URLs, hyphenated terms, and partial substrings — fall back to `regex_search` for those. `project_id: null` searches only the KB; omit the field to span everything; `tags[]` requires ALL listed tags to match. For prompt-ready bundled bodies use `bundle_search`.",
  {
    query: z.string().describe("Search query"),
    project_id: z.number().nullable().optional().describe("Filter by project ID. Pass null to search ONLY Knowledge Base files."),
    tags: z.array(z.string()).optional().describe("Filter by tags (all must match)"),
    favorite: z.boolean().optional().describe("Filter by favorite status"),
  },
  async ({ query, project_id, tags, favorite }) => {
    const filters: any = { query };
    if (project_id !== undefined) filters.project_id = project_id;
    if (tags !== undefined) filters.tags = tags;
    if (favorite !== undefined) filters.favorite = favorite;

    let result;
    try {
      result = search(filters);
    } catch (e: any) {
      if (e instanceof FtsQueryError) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
      throw e;
    }
    const annotated = attachTags(result.map(annotateTokens));
    const total_est_tokens = annotated.reduce((s, f) => s + (f.est_tokens ?? 0), 0);
    return {
      content: [{ type: "text", text: JSON.stringify({ matches: annotated, total_est_tokens }, null, 2) }],
    };
  }
);

server.tool(
  "bundle_search",
  "Run an FTS search and concatenate matched bodies into a single prompt-ready bundle (XML `<document>` blocks or markdown headers + fences) capped at `max_tokens`. Files are added in rank order until the next would exceed the budget; the rest go to `skipped[]`. Read-only; no side effects, auth, or rate limits. Use instead of `search` + N×`read_file` when you need several related files as one context blob. Defaults: format=xml, max_tokens=50000. `project_id: null` = KB only; `tags[]` requires ALL to match.",
  {
    query: z.string().describe("Full-text search query"),
    project_id: z.number().nullable().optional().describe("Filter by project ID. Pass null to bundle ONLY Knowledge Base files."),
    tags: z.array(z.string()).optional().describe("Filter by tags (all must match)"),
    favorite: z.boolean().optional().describe("Filter by favorite status"),
    format: z.enum(["xml", "markdown"]).default("xml")
      .describe("Bundle format. xml = Anthropic-recommended <document> tags; markdown = ## headers + fenced blocks"),
    max_tokens: z.number().int().positive().default(50000)
      .describe("Token budget. Files added in rank order until the next would exceed; remainder go to skipped[]"),
  },
  async ({ query, project_id, tags, favorite, format, max_tokens }) => {
    const filters: any = { query };
    if (project_id !== undefined) filters.project_id = project_id;
    if (tags !== undefined) filters.tags = tags;
    if (favorite !== undefined) filters.favorite = favorite;

    let result;
    try {
      result = await bundleSearch(filters, { format, max_tokens });
    } catch (e: any) {
      if (e instanceof FtsQueryError) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
      throw e;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "add_tags",
  "Append tags to ONE file. Additive — existing tags are preserved; re-adding an existing tag is a no-op (idempotent per tag). New tag names auto-create rows in the global `tags` table. Persists to local SQLite. No external auth or rate limits. Returns `{success: true}`; throws if file_id is unknown. Use to label a single file. To tag every file matching a query in one call use `tag_search_results`; to remove tags use `remove_tags`.",
  {
    file_id: z.number().describe("File ID"),
    tags: z.array(z.string()).describe("Array of tag names to add"),
  },
  async ({ file_id, tags }) => {
    addTags(file_id, tags);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
    };
  }
);

server.tool(
  "remove_tags",
  "Detach one or more tag IDs from ONE file. Destructive on the link only — does NOT delete the file or the global tag definition (orphan tags survive in `list_tags`). Idempotent: removing an already-absent tag is a no-op. No external auth or rate limits. Returns `{success: true}`. Note: takes tag IDs (integers), not names — fetch them via `list_tags`. To remove ALL tags from many files via a query, see `tag_search_results` (additive only) — there is no bulk-untag-by-query tool.",
  {
    file_id: z.number().describe("File ID"),
    tag_ids: z.array(z.number()).describe("Array of tag IDs to remove"),
  },
  async ({ file_id, tag_ids }) => {
    removeTags(file_id, tag_ids);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
    };
  }
);

server.tool(
  "set_favorite",
  "Set or clear the favorite flag on one file (idempotent — re-setting the same value is a no-op; not a toggle, you pass the desired state). Persists to local SQLite. No external auth or rate limits. Returns `{success: true}`. Use to curate quick-access pins; `list_files`/`search`/`bundle_search` accept `favorite: true` to filter to the pinned set.",
  {
    file_id: z.number().describe("File ID"),
    favorite: z.boolean().describe("Favorite status"),
  },
  async ({ file_id, favorite }) => {
    setFavorite(file_id, favorite);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
    };
  }
);

server.tool(
  "list_tags",
  "List every tag in the global SQLite database with id, name, and applied count. Read-only; no side effects, auth, or rate limits. Returns the entire taxonomy (not paginated). Use to discover existing labels before tagging (so you reuse rather than fork) or to find tag IDs to feed into `remove_tags`. For tags on a specific file, use `describe_file`.",
  {},
  async () => {
    const result = listTags();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "list_projects",
  "List every registered project with id, name, absolute path, and a derived `has_hands` flag (true when the path exists on disk AND contains a `kontexta.json`). Read-only; no side effects, auth, or rate limits. Use to find the project_id to pass to scoped tools (`search`, `list_files`, `commit_backup`, `refresh_index`, etc.). To register a new project use `register_project`; to inspect its Hands tools use `list_hands`.",
  {},
  async () => {
    const result = listProjects();
    const augmented = result.map((p: any) => {
      const has_hands = !!(p.path && existsSync(p.path) && existsSync(`${p.path}/kontexta.json`));
      const contextFiles = p.path ? detectAgentContextFiles(p.path) : [];
      const statuses = p.path ? checkAgentRulesStatus(p.path, contextFiles) : [];
      const outdated = statuses.filter((s) => !s.upToDate);

      return {
        ...p,
        has_hands,
        agent_rules: {
          status: outdated.length > 0 ? "outdated" : contextFiles.length > 0 ? "up_to_date" : "none",
          latest_version: RULE_BLOCK_VERSION,
        },
      };
    });
    return {
      content: [{ type: "text", text: JSON.stringify(augmented, null, 2) }],
    };
  }
);

server.tool(
  "register_project",
  `Register a new project and link it to the Kontexta knowledge system.

SIDE EFFECTS: Writes project metadata to disk (persisted in the Kontexta data directory). Scans the project root recursively to discover and index all markdown files into the local database. Registers any kontexta.json-declared Hands tools found in the project root. This operation is idempotent — re-registering an existing project updates its metadata without data loss.

AUTH / RATE LIMITS: None. Operates entirely on the local file system.

PARAMETERS:
- name: Human-readable project name.
- path: Absolute path to the project root. Required. DO NOT guess or assume the path based on the active editor workspace unless the user explicitly asks to register the "current" or "open" project. If the user provides a project name but no path, ask them for the absolute path before calling this tool. Fails with a descriptive error if the path does not exist or is inaccessible.
- description: Optional free-text description stored with the project metadata.

RETURNS: A JSON object containing:
- project: { id, name, path, description, created_at }
- discovered_files_count: number of markdown files indexed
- discovered_files: array of { path, est_tokens, size_bytes } for each file
- total_est_tokens: estimated total token cost of all discovered files
- hands: { found, tools_registered, tools_disabled, warnings }
- warnings: array of non-fatal issues (e.g. scan failures, token budget exceeded)

ERROR CONDITIONS: Returns isError=true if path is missing or unresolvable. Scan failures are non-fatal and reported in warnings rather than as errors.`,
  {
    name: z.string().describe("Project name"),
    path: z.string().describe("Absolute path to the project root. Required. DO NOT guess from the active workspace unless asked. Ask the user if unsure."),
    description: z.string().optional().describe("Optional project description"),
  },
  async ({ name, path, description }) => {
    if (!path) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "Project path is required. Please provide the absolute path to the project." }, null, 2) }],
      };
    }
    try {
      const project = registerProject(name, path, description);
      let discoveredFiles: any[] = [];
      let scanWarning: string | null = null;
      try {
        discoveredFiles = discoverFiles(project.id, dataDir);
      } catch (e: any) {
        scanWarning = `Initial scan failed: ${e?.message ?? e}`;
        console.warn(`registerProject succeeded but discoverFiles failed:`, e);
      }
      const annotated = discoveredFiles.map(annotateTokens);
      const total_est_tokens = annotated.reduce((s, f) => s + (f.est_tokens ?? 0), 0);
      const sizeWarning = tokenWarning(total_est_tokens);
      const warnings = [scanWarning, sizeWarning].filter((w): w is string => !!w);
      const handsResult = handsRegistry.registerProject(project.name, project.path!);
      const handsSummary = {
        found: handsResult.found,
        tools_registered: handsResult.registered,
        tools_disabled: handsResult.disabled,
        warnings: handsResult.warnings,
      };
      const detected = detectAgentContextFiles(project.path!);
      const ruleStatuses = checkAgentRulesStatus(project.path!, detected);
      const outdated = ruleStatuses.filter((s) => !s.upToDate);

      let recommendationReason = "";
      if (detected.length > 0) {
        if (outdated.length > 0) {
          const versions = outdated
            .map((s) => `${s.path} (found ${s.version ?? "none"})`)
            .join(", ");
          recommendationReason =
            `Your project's agent instructions file is out of date — it still references kontexta workflow rules from an older release. ` +
            `Files needing an update: ${versions}. Latest rules version is v${RULE_BLOCK_VERSION}. ` +
            `Run onboard_agent to refresh the kontexta rules block in-place (your existing project content is preserved).`;
        } else {
          recommendationReason =
            `Found ${detected.join(", ")} with kontexta workflow rules already at the latest version (v${RULE_BLOCK_VERSION}). No action needed — your AI agent will load these rules automatically every session.`;
        }
      } else {
        recommendationReason =
          `No AI agent instructions file (e.g. CLAUDE.md, AGENTS.md, GEMINI.md, ANTIGRAVITY.md, .cursor/rules, .continue/rules, .aider/kontexta.md) was found in this project. ` +
          `These files are how coding agents (Claude Code, Codex, Cursor, Gemini, Aider, etc.) load project-specific context at the start of every session. ` +
          `Without one, your agent won't know this project is registered with kontexta and will skip the search/read/journal workflow — wasting tokens re-reading files it could have looked up. ` +
          `Run onboard_agent with target_agent set to your coding tool to scaffold the right file (CLAUDE.md for Claude Code, .aider/kontexta.md for Aider, etc.) pre-populated with kontexta workflow rules.`;
      }

      const needsOnboarding = outdated.length > 0 || detected.length === 0;
      const recommendation =
        detected.length > 0
          ? {
              kind: "onboard_agent" as const,
              mode: "update" as const,
              reason: recommendationReason,
              target_files: detected,
              next_tool: "onboard_agent" as const,
              next_args: { project_id: project.id },
              prompt:
                outdated.length > 0
                  ? `Update the kontexta rules block in ${detected.join(", ")} to v${RULE_BLOCK_VERSION} now? (Your existing project-specific content above/below the rules block will be left untouched.)`
                  : null,
            }
          : {
              kind: "onboard_agent" as const,
              mode: "create" as const,
              reason: recommendationReason,
              target_files: [] as string[],
              next_tool: "onboard_agent" as const,
              next_args: {
                project_id: project.id,
                target_agent: "<pass your agent: claude-code | codex | gemini | antigravity | cursor | continue | aider>",
              },
              prompt:
                "Scaffold an AI agent instructions file now? Tell me which agent you use (claude-code, codex, gemini, antigravity, cursor, continue, or aider) and I'll create the right file (e.g. CLAUDE.md) with the kontexta workflow rules pre-installed, so your agent picks them up on its next session.",
            };

      const content: any[] = [
        {
          type: "text",
          text: JSON.stringify(
            {
              project,
              discovered_files_count: annotated.length,
              total_est_tokens,
              discovered_files: annotated,
              hands: handsSummary,
              recommendation,
              rules_status: ruleStatuses,
              ...(warnings.length ? { warnings } : {}),
            },
            null,
            2
          ),
        },
      ];

      if (needsOnboarding && recommendation.prompt) {
        content.push({
          type: "text",
          text: `\nPROMPT: ${recommendation.prompt}`,
        });
      }

      return { content };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }],
      };
    }
  }
);

server.tool(
  "onboard_agent",
  `Write or update the kontexta workflow rules block in a project's agent context file(s). Idempotent — uses fenced markers + version to skip no-op writes.

MANDATORY: This tool modifies project configuration files. You MUST seek explicit user consent before calling this tool. Set 'confirm: true' only after the user has agreed.

PARAMETERS:
- project_id: number, required.
- confirm: boolean, required. Must be true to proceed.
- files: string[], optional. Paths relative to project root. For update mode, defaults to recommendation.target_files. Ignored when files is empty AND target_agent is provided (create mode).
- target_agent: enum claude-code | codex | gemini | cursor | continue | aider | generic. Required when files is empty AND no context file currently exists. Picks the canonical filename and the starter scaffold.

RETURNS: { written: [{ path, action: created|updated|skipped, version }], skipped: [{ path, reason }] }`,
  {
    project_id: z.number().describe("Project ID returned from register_project"),
    confirm: z.boolean().describe("MANDATORY: Set to true only after obtaining explicit user consent to modify context files."),
    files: z.array(z.string()).optional().describe("Project-relative paths to update; defaults to detected context files"),
    target_agent: z.enum(["claude-code", "codex", "gemini", "antigravity", "cursor", "continue", "aider", "generic"]).optional()
      .describe("Required when files is empty AND no context file exists. Picks the canonical filename + scaffold."),
  },
  async ({ project_id, confirm, files, target_agent }) => {
    try {
      if (confirm !== true) {
        return {
          isError: true,
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              error: "User consent required", 
              details: "This tool modifies project configuration files. You must explain the proposed changes to the user and obtain their explicit consent. Once obtained, re-run this tool with 'confirm: true'." 
            }, null, 2) 
          }],
        };
      }
      const db = getDatabase();
      const project = db
        .prepare("SELECT id, name, path, description FROM projects WHERE id = ?")
        .get(project_id) as
        | { id: number; name: string; path: string | null; description: string | null }
        | undefined;
      if (!project || !project.path) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: `Project ${project_id} not found or has no path` }, null, 2) }],
        };
      }

      const targetFiles = files ?? [];
      if (targetFiles.length === 0 && !target_agent) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "target_agent is required when files is empty (create mode)" }, null, 2) }],
        };
      }

      const result = syncAgentRules({
        projectPath: project.path,
        project: { name: project.name, description: project.description },
        files: targetFiles,
        targetAgent: target_agent as AgentId | undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "commit_backup",
  "SIDE-EFFECTFUL — TOUCHES THE NETWORK. Sync the project's KB data into its git backup directory, create a commit, and `git push` to `origin`. AUTH: relies on the local user's git credentials (SSH agent, credential helper, etc.) — there is no in-server auth. Kontexta does not rate-limit, but the remote may. Idempotent in steady state: a no-op commit is skipped, but the push still runs. Throws if the project has no configured backup repo or if push fails (network, auth, conflict). Returns `{success, copied_files_count, copied_paths}`. Use after a batch of KB writes to get changes off-machine.",
  {
    project_id: z.number().describe("Project ID"),
  },
  async ({ project_id }) => {
    try {
      const copiedPaths = await syncBackup(project_id, dataDir);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                copied_files_count: copiedPaths.length,
                copied_paths: copiedPaths,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "clip_url",
  "SIDE-EFFECTFUL — fetches an EXTERNAL URL and writes a NEW KB file. Downloads the page, extracts the main article via Readability, converts to markdown, and saves it as a new clipping. NOT idempotent / no de-dup — re-clipping the same URL creates a second file. AUTH: anonymous by default; pass `headers` (e.g. `{Cookie: 'session=...'}` or `{Authorization: 'Bearer ...'}`) to clip behind logins. Kontexta does not rate-limit but the upstream may throttle. On auth-required pages returns isError with `code: AUTH_REQUIRED`, optional `login_url`, and a hint to retry with `headers`. Returns `{file_id, path, title, source}`. Use to ingest external docs into the KB.",
  {
    url: z.string().url().describe("The URL to clip"),
    title: z.string().optional().describe("Optional title override (defaults to the page's <title>)"),
    headers: z
      .record(z.string())
      .optional()
      .describe("Optional HTTP headers to forward with the fetch (e.g. {\"Cookie\": \"session=...\"} or {\"Authorization\": \"Bearer ...\"}). Use to clip pages behind auth walls after AUTH_REQUIRED."),
  },
  async ({ url, title, headers }) => {
    try {
      const file = await clipUrl({ url, title, dataDir, headers });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_id: file.id,
                path: file.path,
                title: file.title,
                source: file.source_path,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      const code = e instanceof ClipError ? e.code : "INTERNAL_ERROR";
      const message = (e as Error).message ?? String(e);
      const payload: Record<string, unknown> = { code, message };
      if (e instanceof ClipError && code === "AUTH_REQUIRED") {
        payload.auth_required = true;
        if (e.details.loginUrl) payload.login_url = e.details.loginUrl;
        if (e.details.signal) payload.signal = e.details.signal;
        if (e.details.wwwAuthenticate) payload.www_authenticate = e.details.wwwAuthenticate;
        payload.hint = "Page requires authentication. Retry with the optional `headers` param (e.g. {\"Cookie\": \"...\"} or {\"Authorization\": \"Bearer ...\"}).";
      }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  }
);

function repoDirForFile(file: { storage_type: string; project_id: number | null }): string {
  if (file.storage_type === "reference" && file.project_id) {
    const project = getDatabase()
      .prepare("SELECT path FROM projects WHERE id = ?")
      .get(file.project_id) as { path: string | null } | undefined;
    if (project?.path) return project.path;
  }
  return dataDir;
}

server.tool(
  "get_history",
  "Return the git commit history for one file (newest first), each entry with hash, message, date, and author. Reads the file's owning repo: the project's git repo for project files, the KB backup repo for KB files. Read-only; no side effects, auth, or rate limits. Returns `{file_id, path, history}`; an empty array means the file has not been committed yet. Use to understand a file's evolution before editing or restoring. Pair with `get_diff` to see exact line changes; use `restore_file` to roll back.",
  {
    file_id: z.number().describe("ID of the file"),
  },
  async ({ file_id }) => {
    const file = readFile(file_id);
    const history = await getHistory(repoDirForFile(file), file.path);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ file_id, path: file.path, history }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_diff",
  "Return the unified diff of one file between two commit hashes (typically obtained from `get_history` for the same file). Read-only; no side effects, auth, or rate limits. Order matters — `commit_a` is treated as the earlier side; reversing the args inverts the diff. Throws if either hash is unknown to the file's repo. Use after `get_history` to see WHAT changed, not just THAT it changed.",
  {
    file_id: z.number().describe("ID of the file"),
    commit_a: z.string().describe("Earlier commit hash (from get_history)"),
    commit_b: z.string().describe("Later commit hash (from get_history)"),
  },
  async ({ file_id, commit_a, commit_b }) => {
    const file = readFile(file_id);
    const diff = await getDiff(repoDirForFile(file), file.path, commit_a, commit_b);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ file_id, path: file.path, commit_a, commit_b, diff }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "restore_file",
  "DESTRUCTIVE. Overwrite a file's current on-disk content with the version recorded at a specific git commit, then re-index FTS. The hash MUST come from `get_history` for THIS file (foreign hashes throw). The current uncommitted content is lost unless it was already committed elsewhere. The file watcher may also pick up the change before this returns. No external auth or rate limits. Returns `{file_id, path, hash, success, message}`. Use only to undo accidental edits or recover a known-good version.",
  {
    file_id: z.number().describe("ID of the file"),
    hash: z.string().describe("Commit hash to restore from (from get_history)"),
  },
  async ({ file_id, hash }) => {
    try {
      const file = readFile(file_id);
      const content = await restoreVersion(repoDirForFile(file), file.path, hash);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_id,
                path: file.path,
                hash,
                success: true,
                message: `File restored to version ${hash.slice(0, 7)}`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }],
      };
    }
  }
);


server.tool(
  "read_file_outline",
  "Return a flat list of markdown headings for one file (level, text, line, byteStart, byteEnd). Read-only; no side effects, auth, or rate limits. Use as a cheap probe before `read_section` or `update_file_section` so you don't spend tokens on the full body just to learn what sections exist. Empty outline means the file has no markdown headings (it may still have content — fall back to `read_file` or `read_file_lines`).",
  {
    file_id: z.number().describe("File ID"),
  },
  async ({ file_id }) => {
    try {
      const file = readFile(file_id);
      const outline = parseOutline(file.content).map((n) => ({
        level: n.level,
        text: n.text,
        line: n.line,
        byteStart: n.byteStart,
        byteEnd: n.byteEnd,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { file_id, path: file.path, title: file.title, outline },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "read_section",
  "Return the body of ONE heading (the heading line itself is excluded) plus level, line, size_bytes, and est_tokens. Heading match is case-insensitive but exact-string after trim — fuzzy / partial matches do NOT resolve. Returns isError if the heading is absent. Read-only; no side effects, auth, or rate limits. Pair with `read_file_outline` when you are unsure which headings exist; for non-heading line ranges use `read_file_lines`.",
  {
    file_id: z.number().describe("File ID"),
    heading: z.string().describe("Heading text to extract (case-insensitive)"),
  },
  async ({ file_id, heading }) => {
    try {
      const file = readFile(file_id);
      const node = findSection(file.content, heading);
      if (!node) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: `Section not found: ${heading}` }, null, 2) }],
        };
      }
      const buf = Buffer.from(file.content, "utf8");
      const body = buf.subarray(node.contentStart, node.contentEnd).toString("utf8");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_id,
                path: file.path,
                heading: node.text,
                level: node.level,
                line: node.line,
                content: body,
                size_bytes: Buffer.byteLength(body, "utf8"),
                est_tokens: estimateTokensFromBuffer(Buffer.from(body, "utf8")),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "update_file_section",
  "Surgical write — replace the body of ONE heading without touching siblings. The heading line itself is preserved verbatim; only its body is rewritten. Persists via the same path as `update_file` (writes to disk → FTS reindex → git commit). Throws if the heading does not exist (this tool will NOT create a new section — append the section text via `update_file` first). Heading match is case-insensitive exact-string. No external auth or rate limits. Returns the updated file metadata. Use to make targeted edits without re-sending the whole body; for full-file replacement use `update_file`.",
  {
    file_id: z.number().describe("File ID"),
    heading: z.string().describe("Heading whose body to replace (case-insensitive)"),
    content: z.string().describe("New body content (heading line is preserved automatically)"),
  },
  async ({ file_id, heading, content }) => {
    try {
      const file = readFile(file_id);
      const updated = replaceSection(file.content, heading, content);
      const result = await updateFile(file_id, updated, dataDir);
      return {
        content: [{ type: "text", text: JSON.stringify(annotateTokens(result), null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

function resolveFolderBase(projectId: number | null | undefined): string {
  if (projectId === undefined || projectId === null) {
    return join(dataDir, "knowledge");
  }
  const project = getDatabase()
    .prepare("SELECT path FROM projects WHERE id = ?")
    .get(projectId) as { path: string | null } | undefined;
  if (!project?.path) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return project.path;
}

function validateFolderName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("name must be a non-empty string");
  }
  if (name.includes("\0")) throw new Error("name contains null byte");
  if (name.startsWith("/") || name.startsWith("\\")) {
    throw new Error("name must not start with a path separator");
  }
  if (name.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new Error("name must not contain '..' segments");
  }
}

server.tool(
  "list_folders",
  "List folder paths under a project root (or the Knowledge Base when `project_id` is null/omitted). Returns `{folders: string[], base_path}` where `folders` are RELATIVE to `base_path`. Read-only; no side effects, auth, or rate limits. Throws if `project_id` references an unknown project. Use to discover where to drop a new file via `create_file`'s `folder` argument or to navigate vault structure; to actually create one use `create_folder`.",
  {
    project_id: z.number().nullable().optional().describe("Project ID. Pass null or omit to list KB folders."),
  },
  async ({ project_id }) => {
    try {
      const base = resolveFolderBase(project_id);
      const folders = listProjectFolders(base);
      return {
        content: [{ type: "text", text: JSON.stringify({ folders, base_path: base }, null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "create_folder",
  "Create a folder under a project root or the KB. Idempotent — creating an existing folder succeeds. Nested paths like `notes/inbox` create intermediates. REJECTS: empty names, null bytes, leading path separators, and any segment equal to `..` (the call returns isError, no folder is touched). Side effect: a directory is mkdir'd on disk; no DB rows are written until a file lands inside. No external auth or rate limits. Returns `{path, base_path}`.",
  {
    project_id: z.number().nullable().optional().describe("Project ID. Pass null or omit to create the folder under the KB."),
    name: z.string().describe("Folder name (relative; supports nested paths via '/')"),
  },
  async ({ project_id, name }) => {
    try {
      validateFolderName(name);
      const base = resolveFolderBase(project_id);
      const path = createFolder(base, name);
      return {
        content: [{ type: "text", text: JSON.stringify({ path, base_path: base }, null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "delete_folder",
  "DESTRUCTIVE — recursively delete a folder under the KB AND every file inside it (disk + FTS rows). REFUSES (returns isError) when `project_id` is supplied: deleting inside a registered project would race the file watcher and re-ingest the contents — remove project content via your editor instead. Same name validation as `create_folder`. Not recoverable from Kontexta after the call (only the git backup, if configured, retains it). No external auth or rate limits. Returns `{success: true}`.",
  {
    project_id: z.number().nullable().optional().describe("Project ID. Pass null or omit to delete from the KB. Project IDs are rejected."),
    name: z.string().describe("Folder name (relative)"),
  },
  async ({ project_id, name }) => {
    try {
      validateFolderName(name);
      if (project_id !== undefined && project_id !== null) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error:
                    "Cannot delete folders inside a registered project. The watcher would re-ingest the contents. Unregister the project or remove the folder from disk in your editor instead.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      const base = resolveFolderBase(null);
      deleteFolder(base, name);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "move_file",
  "Move/rename a file. Destination 'new_path' must be absolute and resolve INSIDE the file's owning project or global knowledge directory. Cross-project moves are rejected. Operates locally with no auth or limits. Parameters: 'file_id' is a valid file ID. 'new_path' is an absolute path.",
  {
    file_id: z.number().describe("File ID"),
    new_path: z.string().describe("Absolute destination path"),
  },
  async ({ file_id, new_path }) => {
    try {
      if (typeof new_path !== "string" || new_path.length === 0) {
        throw new Error("new_path is required");
      }
      if (new_path.includes("\0")) throw new Error("new_path contains null byte");
      if (!isAbsolute(new_path)) throw new Error("new_path must be absolute");

      const file = readFile(file_id);
      let base: string;
      if (file.storage_type === "reference" && file.project_id) {
        const project = getDatabase()
          .prepare("SELECT path FROM projects WHERE id = ?")
          .get(file.project_id) as { path: string | null } | undefined;
        if (!project?.path) throw new Error(`Project not found for file ${file_id}`);
        base = project.path;
      } else {
        base = join(dataDir, "knowledge");
      }
      // Use realpath to follow symlinks before the containment check —
      // path.resolve() only normalises `.`/`..`, so a symlink inside the
      // vault pointing outside (e.g. knowledge/escape -> /etc) would let
      // moveFile write through it. realpath the dest's PARENT since the
      // destination itself doesn't exist yet.
      let baseResolved: string;
      try {
        baseResolved = realpathSync(resolve(base));
      } catch {
        throw new Error(`Base directory does not exist: ${base}`);
      }
      const destAbs = resolve(new_path);
      const destParent = dirname(destAbs);
      let destParentReal: string;
      try {
        destParentReal = realpathSync(destParent);
      } catch {
        throw new Error(`Destination parent directory does not exist: ${destParent}`);
      }
      const destResolved = join(destParentReal, destAbs.slice(destParent.length + (destParent.endsWith(sep) ? 0 : 1)));
      if (destResolved !== baseResolved && !destResolved.startsWith(baseResolved + sep)) {
        throw new Error(`new_path must be inside ${base}`);
      }
      // Defense-in-depth: also confirm the SOURCE lives under the same base.
      // If a project was re-registered to a new path after this file was
      // ingested, fileRecord.path can point outside the current base — and
      // without this check moveFile would relocate that orphan into the
      // project root.
      let srcResolved: string;
      try {
        srcResolved = realpathSync(resolve(file.path));
      } catch {
        srcResolved = resolve(file.path);
      }
      if (srcResolved !== baseResolved && !srcResolved.startsWith(baseResolved + sep)) {
        throw new Error(`source path ${file.path} is no longer inside ${base}; refusing to move`);
      }

      const updated = moveFile(file_id, new_path);
      return {
        content: [{ type: "text", text: JSON.stringify(annotateTokens(updated as any), null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "find_related",
  "Find other files sharing tags with the given file, ranked by `shared_tag_count` descending. Read-only; no side effects, auth, or rate limits. Returns annotated file rows with `shared_tag_count` and `shared_tags`. Empty result means the file has no tags or no other file shares them — try `search`/`regex_search` for content-based discovery, or `suggest_tags` to bootstrap labels first. Default limit 10.",
  {
    file_id: z.number().describe("ID of the file to find relations for"),
    limit: z.number().optional().describe("Maximum number of related files to return (default 10)"),
  },
  async ({ file_id, limit }) => {
    const related = findRelated(file_id, limit ?? 10);
    const annotated = related.map((r) => ({ ...annotateTokens(r), shared_tag_count: r.shared_tag_count, shared_tags: r.shared_tags }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ file_id, related: annotated }, null, 2),
        },
      ],
    };
  }
);


server.tool(
  "create_files",
  "Batch variant of `create_file` — create up to 200 markdown or mermaid files in one call. Each item follows the same rules (project_id required if destination is `project` or `kontexta`). SIDE EFFECTS: writes new files to disk and inserts FTS5 rows; missing folders are mkdir'd. Per-item failures are isolated to `errors[]` and the rest of the batch still commits — partial success is the norm, always inspect `error_count`. No external auth or rate limits. Returns `{created_count, error_count, created, errors}`. Use for bulk ingestion; for >200 items, page yourself. Pass format='mmd' on an item to create a Mermaid diagram file (.mmd); defaults to 'md'.",
  {
    files: z
      .array(
        z.object({
          title: z.string(),
          content: z.string(),
          destination: z.enum(["knowledge", "project", "kontexta"]),
          project_id: z.number().optional(),
          folder: z.string().optional(),
          tags: z.array(z.string()).optional(),
          format: z.enum(["md", "mmd"]).optional(),
        })
      )
      .min(1)
      .max(200)
      .describe("Files to create (max 200 per call)"),
  },
  async ({ files }) => {
    const created: any[] = [];
    const errors: { index: number; title: string; error: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const result = await createFile({
          title: f.title,
          content: f.content,
          destination: f.destination,
          projectId: f.project_id,
          folder: f.folder,
          tags: f.tags,
          dataDir,
          format: f.format,
        });
        created.push(annotateTokens(result));
      } catch (e: any) {
        errors.push({ index: i, title: f.title, error: e?.message ?? String(e) });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { created_count: created.length, error_count: errors.length, created, errors },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "delete_files",
  "DESTRUCTIVE batch — delete up to 500 files by ID in one call. Same physical-deletion rules as `delete_file` (KB files unlinked from disk; project reference files only de-indexed). Per-ID failures isolated to `errors[]`; the batch keeps going — partial success is the norm. Not idempotent — unknown IDs surface as per-item errors. No external auth or rate limits. Returns `{deleted_count, error_count, deleted, errors}`. To preview the set before deleting, run `list_files` with the same filter and confirm the IDs.",
  {
    ids: z.array(z.number()).min(1).max(500).describe("File IDs to delete (max 500 per call)"),
  },
  async ({ ids }) => {
    const deleted: number[] = [];
    const errors: { id: number; error: string }[] = [];
    for (const id of ids) {
      try {
        deleteFile(id, dataDir);
        deleted.push(id);
      } catch (e: any) {
        errors.push({ id, error: e?.message ?? String(e) });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { deleted_count: deleted.length, error_count: errors.length, deleted, errors },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "tag_search_results",
  "Bulk-tag — run an FTS `search` and append `add_tags` to every matching file in one call. Side effect: each match gets `addTags` applied (additive, idempotent per tag); the matched files themselves are NOT modified beyond their tag links. Per-file failures isolated to `errors[]`. No external auth or rate limits. There is NO dry-run flag, so ALWAYS run `search` with the same query first to verify the match set before tagging. The `tags[]` filter requires existing tags to ALL match (it scopes the search; it does not control which tags get added). Returns `{matched_count, tagged_count, tags_applied, tagged_ids, errors}`.",
  {
    query: z.string().describe("Full-text search query"),
    add_tags: z.array(z.string()).min(1).describe("Tags to add to every matching file"),
    project_id: z.number().nullable().optional(),
    tags: z.array(z.string()).optional().describe("Filter — only matches that already carry ALL of these tags"),
    favorite: z.boolean().optional(),
  },
  async ({ query, add_tags, project_id, tags, favorite }) => {
    const filters: any = { query };
    if (project_id !== undefined) filters.project_id = project_id;
    if (tags !== undefined) filters.tags = tags;
    if (favorite !== undefined) filters.favorite = favorite;
    let matches;
    try {
      matches = search(filters);
    } catch (e: any) {
      if (e instanceof FtsQueryError) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
      throw e;
    }
    const tagged: number[] = [];
    const errors: { id: number; error: string }[] = [];
    for (const m of matches) {
      try {
        addTags(m.id, add_tags);
        tagged.push(m.id);
      } catch (e: any) {
        errors.push({ id: m.id, error: e?.message ?? String(e) });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              matched_count: matches.length,
              tagged_count: tagged.length,
              tags_applied: add_tags,
              tagged_ids: tagged,
              errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "read_file_by_path",
  "Look up a file by its absolute on-disk path and return the same shape as `read_file`. The path must EXACTLY match what Kontexta indexed — no symlink resolution, no path normalisation beyond what the OS does, no trailing-slash tolerance. Returns isError if no row matches (the file may exist on disk but not be indexed — try `refresh_index`). Read-only; no side effects, auth, or rate limits. Use when an agent has a path from its working directory but no file ID; if you have the ID, prefer `read_file`.",
  {
    path: z.string().describe("Absolute path on disk (must match the path stored in Kontexta)"),
  },
  async ({ path }) => {
    try {
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("path is required");
      }
      const row = getDatabase()
        .prepare("SELECT id FROM files WHERE path = ?")
        .get(path) as { id: number } | undefined;
      if (!row) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No file indexed at path: ${path}` }, null, 2),
            },
          ],
        };
      }
      const result = readFile(row.id);
      return {
        content: [{ type: "text", text: JSON.stringify(annotateTokens(result), null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "stats",
  "Aggregate counts for a scope: `file_count`, `untagged_count`, `favorite_count`, `top_tags`. With `project_id` omitted (everything), also returns `by_project` breakdown. `include_token_total: true` stat()s every matching file on disk to compute a body-size estimate — measurably slower on large vaults; default false. `project_id: null` = KB only; omit = all. Read-only; no side effects, auth, or rate limits. Use as a cheap dashboard or to spot untagged content for cleanup; for live disk-vs-index drift use `diff_against_disk`.",
  {
    project_id: z.number().nullable().optional().describe("Filter to a single project. Pass null for KB-only. Omit for everything."),
    top_tags: z.number().int().positive().max(100).optional().describe("How many top tags to return (default 10)"),
    include_token_total: z.boolean().optional().describe("If true, stat every matching file on disk to compute total est_tokens. Default false (cheap)."),
  },
  async ({ project_id, top_tags, include_token_total }) => {
    try {
      const db = getDatabase();
      const limit = top_tags ?? 10;

      let scopeWhere = "";
      const scopeParams: any[] = [];
      if (project_id === null) {
        scopeWhere = "WHERE files.project_id IS NULL";
      } else if (typeof project_id === "number") {
        scopeWhere = "WHERE files.project_id = ?";
        scopeParams.push(project_id);
      }

      const fileCount = (db
        .prepare(`SELECT COUNT(*) AS n FROM files ${scopeWhere}`)
        .get(...scopeParams) as { n: number }).n;

      const untaggedCount = (db
        .prepare(
          `SELECT COUNT(*) AS n FROM files ${scopeWhere}${scopeWhere ? " AND" : "WHERE"} files.id NOT IN (SELECT DISTINCT file_id FROM file_tags)`
        )
        .get(...scopeParams) as { n: number }).n;

      const favoriteCount = (db
        .prepare(
          `SELECT COUNT(*) AS n FROM files ${scopeWhere}${scopeWhere ? " AND" : "WHERE"} files.id IN (SELECT file_id FROM favorites)`
        )
        .get(...scopeParams) as { n: number }).n;

      const topTags = db
        .prepare(
          `SELECT t.name, COUNT(*) AS count
           FROM file_tags ft
           JOIN tags t ON t.id = ft.tag_id
           JOIN files ON files.id = ft.file_id
           ${scopeWhere}
           GROUP BY t.id
           ORDER BY count DESC, t.name ASC
           LIMIT ?`
        )
        .all(...scopeParams, limit) as { name: string; count: number }[];

      const byProject =
        project_id === undefined
          ? (db
              .prepare(
                `SELECT p.id, p.name, COUNT(files.id) AS files
                 FROM projects p
                 LEFT JOIN files ON files.project_id = p.id
                 GROUP BY p.id
                 ORDER BY files DESC, p.name ASC`
              )
              .all() as { id: number; name: string; files: number }[])
          : null;

      let totalEstTokens: number | null = null;
      if (include_token_total) {
        const rows = db
          .prepare(`SELECT path FROM files ${scopeWhere}`)
          .all(...scopeParams) as { path: string }[];
        let total = 0;
        for (const r of rows) {
          try {
            const sz = statSync(r.path).size;
            total += Math.max(1, Math.ceil(sz / 4));
          } catch {}
        }
        totalEstTokens = total;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                scope:
                  project_id === undefined
                    ? "all"
                    : project_id === null
                      ? "knowledge_base"
                      : `project:${project_id}`,
                file_count: fileCount,
                untagged_count: untaggedCount,
                favorite_count: favoriteCount,
                top_tags: topTags,
                ...(byProject ? { by_project: byProject } : {}),
                ...(totalEstTokens !== null ? { total_est_tokens: totalEstTokens } : {}),
                rules_warning: getAgentRulesWarning(project_id),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);


server.tool(
  "suggest_tags",
  "Propose tags for a file by mining the existing tag corpus via FTS — picks distinctive terms from the file (≥4 chars, stopword-filtered) and returns tags applied to other files that score high on those terms. No LLM, no network. Already-applied tags are excluded so the suggestions are net-new. Read-only; no side effects, auth, or rate limits. Returns `{file_id, path, existing_tags, suggestions: [{tag, score, sources}]}`. Empty suggestions = no distinctive terms or no overlap with the existing taxonomy yet — bootstrap with `add_tags` first. Default limit 10, max 50. Suggestions are NOT auto-applied.",
  {
    file_id: z.number().describe("File ID to suggest tags for"),
    limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default 10)"),
  },
  async ({ file_id, limit }) => {
    try {
      const k = limit ?? 10;
      const file = readFile(file_id);
      const db = getDatabase();

      const existing = new Set(
        (db
          .prepare(
            `SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = ?`
          )
          .all(file_id) as { name: string }[]).map((r) => r.name)
      );

      const STOPWORDS = new Set([
        "the","and","for","with","from","this","that","have","into","your",
        "more","than","then","when","what","which","there","these","those",
        "where","while","also","been","were","would","should","could","about",
      ]);
      const tokens = (file.title + " " + file.content)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
      const seen = new Set<string>();
      const distinctive: string[] = [];
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          distinctive.push(t);
          if (distinctive.length >= 40) break;
        }
      }
      if (distinctive.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ suggestions: [], reason: "no distinctive terms in file" }, null, 2) }],
        };
      }
      const ftsQuery = distinctive.map((t) => `"${t}"`).join(" OR ");

      const rows = db
        .prepare(
          `SELECT t.name, fts_index.rank
           FROM fts_index
           JOIN file_tags ft ON ft.file_id = fts_index.rowid
           JOIN tags t ON t.id = ft.tag_id
           WHERE fts_index MATCH ?
             AND ft.file_id != ?
           LIMIT 500`
        )
        .all(ftsQuery, file_id) as { name: string; rank: number }[];

      const scores = new Map<string, { score: number; sources: number }>();
      for (const r of rows) {
        if (existing.has(r.name)) continue;
        const w = -r.rank;
        const cur = scores.get(r.name);
        if (cur) {
          cur.score += w;
          cur.sources += 1;
        } else {
          scores.set(r.name, { score: w, sources: 1 });
        }
      }
      const suggestions = [...scores.entries()]
        .map(([name, { score, sources }]) => ({ tag: name, score: Number(score.toFixed(2)), sources }))
        .sort((a, b) => b.score - a.score || b.sources - a.sources || a.tag.localeCompare(b.tag))
        .slice(0, k);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { file_id, path: file.path, existing_tags: [...existing], suggestions },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "diff_against_disk",
  "Diagnose drift between one file's disk content and its FTS index. Status is one of `in_sync`, `diverged`, `disk_unreadable`, or `no_index_row`. On divergence returns sizes, line counts, the first divergent line number, and the disk vs index sample for that line — NOT a full diff (use `get_diff` for full diffs between commits). Read-only; no side effects, auth, or rate limits. Use when search results look stale; if status is `diverged` or `no_index_row`, run `refresh_index` to fix.",
  {
    file_id: z.number().describe("File ID"),
  },
  async ({ file_id }) => {
    try {
      const db = getDatabase();
      const row = db
        .prepare("SELECT path FROM files WHERE id = ?")
        .get(file_id) as { path: string } | undefined;
      if (!row) throw new Error(`File not found: ${file_id}`);

      let diskContent: string | null = null;
      let diskError: string | null = null;
      try {
        statSync(row.path);
        diskContent = readFileSync(row.path, "utf8");
      } catch (e: any) {
        diskError = e?.message ?? String(e);
      }

      const ftsRow = db
        .prepare("SELECT content FROM fts_index WHERE rowid = ?")
        .get(file_id) as { content: string } | undefined;
      const indexContent = ftsRow?.content ?? null;

      if (diskContent === null) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  file_id,
                  path: row.path,
                  status: "disk_unreadable",
                  disk_error: diskError,
                  index_size: indexContent ? Buffer.byteLength(indexContent, "utf8") : null,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      if (indexContent === null) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  file_id,
                  path: row.path,
                  status: "no_index_row",
                  disk_size: Buffer.byteLength(diskContent, "utf8"),
                  hint: "FTS index missing for this file. Touch it and let the watcher reingest, or run an explicit refresh.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (diskContent === indexContent) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  file_id,
                  path: row.path,
                  status: "in_sync",
                  size_bytes: Buffer.byteLength(diskContent, "utf8"),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const diskLines = diskContent.split("\n");
      const idxLines = indexContent.split("\n");
      let firstDiffLine = -1;
      const maxLines = Math.max(diskLines.length, idxLines.length);
      for (let i = 0; i < maxLines; i++) {
        if (diskLines[i] !== idxLines[i]) {
          firstDiffLine = i + 1;
          break;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                file_id,
                path: row.path,
                status: "diverged",
                disk_size: Buffer.byteLength(diskContent, "utf8"),
                index_size: Buffer.byteLength(indexContent, "utf8"),
                disk_line_count: diskLines.length,
                index_line_count: idxLines.length,
                first_diff_line: firstDiffLine,
                disk_sample: firstDiffLine > 0 ? (diskLines[firstDiffLine - 1] ?? null) : null,
                index_sample: firstDiffLine > 0 ? (idxLines[firstDiffLine - 1] ?? null) : null,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);

server.tool(
  "refresh_index",
  "Reconcile the FTS index against disk. For a project (`project_id` set), re-runs `discoverFiles`. For the KB (`project_id` null/omitted), walks `knowledge/`, ingests new .md files, reindexes any whose content hash drifted, and PRUNES rows for files no longer on disk. SIDE-EFFECTFUL: writes/updates/deletes file and FTS rows (the prune is destructive on stale index rows but never deletes files from disk). Idempotent — running twice is a near no-op. Skips files >5MB and standard junk dirs (`node_modules`, `.git`, `dist`, `build`, etc.). No external auth or rate limits. Returns `{scope, newly_indexed, refreshed, pruned}`. Use after editing files outside Kontexta, or when `diff_against_disk` reports drift.",
  {
    project_id: z.number().nullable().optional().describe("Project ID. Pass null or omit to reindex the Knowledge Base."),
  },
  async ({ project_id }) => {
    try {
      const result = await refreshIndex(project_id ?? null, dataDir);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e?.message ?? String(e) }, null, 2) }],
      };
    }
  }
);


server.tool(
  "whats_new",
  "List files created or modified since a checkpoint. `since` accepts ISO-8601 (`2025-01-15T00:00:00Z`) or relative durations (`1h`, `7d`, `2w`); invalid formats throw. Read-only; no side effects, auth, or rate limits. Returns annotated rows plus aggregate `total_est_tokens` so you can decide what to read next. CAVEAT: hard-deleted files are NOT surfaced — only mtime-driven changes. Defaults: include_tags=true, limit=200. `project_id: null` = KB only; omit = everything. Use at session start to catch up.",
  {
    since: z.string().describe("ISO 8601 timestamp or relative duration (e.g. \"1h\", \"7d\", \"2w\")."),
    project_id: z.number().nullable().optional().describe("Filter to a single project. Pass null for knowledge-base-only files. Omit for all."),
    include_tags: z.boolean().optional().describe("Attach tags[] to each file. Default true."),
    limit: z.number().optional().describe("Max files returned. Default 200."),
  },
  async ({ since, project_id, include_tags, limit }) => {
    try {
      const opts: any = { since };
      if (project_id !== undefined) opts.project_id = project_id;
      if (include_tags !== undefined) opts.include_tags = include_tags;
      if (limit !== undefined) opts.limit = limit;
      const result = whatsNew(opts);
      const annotated = result.files.map(annotateTokens);
      const total_est_tokens = annotated.reduce((s, f) => s + (f.est_tokens ?? 0), 0);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                since: result.since,
                until: result.until,
                count: result.count,
                total_est_tokens,
                files: annotated,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: (e as Error).message }, null, 2) }],
      };
    }
  }
);

server.tool(
  "project_map",
  "Return a compact indented outline of folders, file titles, tags, and IDs in a single dense block — substantially fewer tokens than the equivalent `list_files` JSON for the same scope. Read-only; no side effects, auth, or rate limits. Capped at `max_lines` (default 5000); the response reports `est_tokens` and emits a `warning` field if it exceeds `KONTEXTA_PROJECT_TOKEN_WARN`. `project_id: null` = KB only; omit = everything. Defaults: include_tags=true, show_titles=true. Use to orient yourself in an unfamiliar vault or project; for keyword lookup use `search`.",
  {
    project_id: z.number().nullable().optional().describe("Restrict to a single project. Pass null for knowledge-base-only files. Omit for everything."),
    include_tags: z.boolean().optional().describe("Append #tags inline. Default true. Set false to shrink the outline."),
    show_titles: z.boolean().optional().describe("Show file titles instead of filenames. Default true."),
    max_lines: z.number().optional().describe("Hard cap on output lines (each line ≈ one folder or file). Default 5000."),
  },
  async ({ project_id, include_tags, show_titles, max_lines }) => {
    const opts: any = { dataDir };
    if (project_id !== undefined) opts.project_id = project_id;
    if (include_tags !== undefined) opts.include_tags = include_tags;
    if (show_titles !== undefined) opts.show_titles = show_titles;
    if (max_lines !== undefined) opts.max_lines = max_lines;
    const result = projectMap(opts);
    const warning = tokenWarning(result.est_tokens);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              stats: result.stats,
              est_tokens: result.est_tokens,
              outline: result.outline,
              ...(warning ? { warning } : {}),
              rules_warning: getAgentRulesWarning(opts.project_id),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.resource(
  "All Projects",
  "kontexta://projects",
  {
    description: "List of all registered projects",
    mimeType: "application/json",
  },
  async () => {
    const projects = listProjects();
    const enriched = projects.map((p: any) => {
      const contextFiles = p.path ? detectAgentContextFiles(p.path) : [];
      const statuses = p.path ? checkAgentRulesStatus(p.path, contextFiles) : [];
      const outdated = statuses.filter((s) => !s.upToDate);
      return {
        ...p,
        agent_rules: {
          status: outdated.length > 0 ? "outdated" : contextFiles.length > 0 ? "up_to_date" : "none",
          files: statuses,
          latest_version: RULE_BLOCK_VERSION,
        },
      };
    });
    return {
      contents: [
        {
          uri: "kontexta://projects",
          mimeType: "application/json",
          text: JSON.stringify(enriched, null, 2),
        },
      ],
    };
  }
);

server.resource(
  "File Content",
  new ResourceTemplate("kontexta://files/{id}", {
    list: undefined,
  }),
  {
    description: "Content of a specific file by ID",
    mimeType: "text/markdown",
  },
  async (uri, variables) => {
    const idValue = Array.isArray(variables.id) ? variables.id[0] : variables.id;
    const id = parseInt(idValue, 10);
    const file = readFile(id);

    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: file.content,
        },
      ],
    };
  }
);

server.tool(
  "list_hands",
  "List every Hands command tool currently registered, with project scope, tool name, danger level, confirmation flag, and description. Hands tools come from per-project `kontexta.json` files loaded at register time. Read-only; no side effects, auth, or rate limits. Use to discover what side-effectful project commands the agent is permitted to run; for the `kontexta.json` schema see `describe_hands_schema`; reload after editing one with `reload_hands`.",
  {},
  async () => {
    const items = handsRegistry.list();
    return { content: [{ type: "text", text: JSON.stringify({ hands: items }, null, 2) }] };
  }
);

server.tool(
  "reload_hands",
  "Re-scan every registered project's `kontexta.json` and rebuild the live Hands tool registry — newly-declared tools become callable immediately, removed tools disappear from `tools/list`. SIDE EFFECT is on the running MCP session's tool inventory only (no disk writes). Idempotent. No external auth or rate limits. Takes no parameters. Returns per-project load results (counts of registered/disabled tools and any validation warnings). Use after editing a `kontexta.json` mid-session; for the schema see `describe_hands_schema`.",
  {},
  async () => {
    const projects = listProjects()
      .filter((p: any) => p.path && existsSync(p.path))
      .map((p: any) => ({ name: p.name, root: p.path }));
    const r = handsRegistry.reloadAll(projects);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

server.tool(
  "confirm_hand",
  "Approve and EXECUTE a previously-issued Hands invocation by its single-use approval token. The token is returned by any confirm-required Hands tool; tokens expire after 60 seconds and CANNOT be reused. Side effect equals whatever the underlying Hand does — this can be highly destructive (running arbitrary shell commands, modifying files, etc.), so only call when the user has authorised the pending action. The token IS the auth (no external auth, no rate limits). Invalid, expired, or already-consumed tokens return an inert text response, NOT an error.",
  { token: z.string().describe("The approval token from the pending response") },
  async ({ token }) => {
    const pending = handsRegistry.getConfirmStore().consume(token);
    if (!pending) {
      return { content: [{ type: "text", text: "Token invalid, expired, or already consumed." }] };
    }
    try {
      const result = await pending.execute();
      return { content: [{ type: "text", text: formatExecResult(pending.toolName, result) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Execution failed after approval: ${e?.message ?? e}` }] };
    }
  }
);

server.tool(
  "describe_hands_schema",
  "Return the complete authoring reference for `kontexta.json`: JSON schema, validation rules, security guarantees, limitations, and an annotated example. Static document — does not read any project file or DB row. Read-only; no side effects, auth, or rate limits. Takes no parameters. Use when helping a user write or fix a `kontexta.json`; to see the loaded tools themselves use `list_hands`; to apply edits use `reload_hands`.",
  {},
  async () => ({ content: [{ type: "text", text: buildSchemaDoc() }] })
);

async function main() {
  const transport = new StdioServerTransport();
  {
    const projects = listProjects()
      .filter((p: any) => p.path && existsSync(p.path))
      .map((p: any) => ({ name: p.name, root: p.path }));
    const r = handsRegistry.reloadAll(projects);
    console.error(
      `Kontexta Hands: loaded ${r.perProject.length} projects, registered ${r.totalRegistered} tools (${r.totalDisabled} disabled)`
    );
  }
  registerJournalTools(server);
  registerCommitUpgradesTool(server);
  registerHousekeepTool(server);
  await server.connect(transport);
  console.error("Kontexta MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
