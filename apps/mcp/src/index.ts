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
  assertPathInside,
  syncAgentRules,
  checkAgentRulesStatus,
  RULE_BLOCK_VERSION,
  gracefulShutdown,
  startDistillEngine,
  writeResource,
  listResources,
  deleteResource,
  type AgentId,
  type RawEvent,
} from "kxta-core";
import RE2Class from "./re2-compat.js";
import type RE2 from "re2";
import { isAbsolute, join, relative, resolve, sep, dirname } from "node:path";
import os from "node:os";
import { statSync, lstatSync, openSync, readSync, closeSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HandsRegistry } from "./hands/registry.js";
import { buildSchemaDoc } from "./hands/schema-doc.js";
import { formatExecResult } from "./hands/formatter.js";
import { killAllActiveChildren } from "./hands/executor.js";
import { initCapture, shutdownCapture, wrapHandler, startGitPoller, appendVoluntaryEvent, getCurrentAgent, getCurrentSid } from "./journal-capture.js";
import { registerJournalTools } from "./journal-tools.js";
import { registerCommitUpgradesTool } from "./journal-commit-upgrades-tool.js";
import { registerHousekeepTool } from "./journal-housekeep-tool.js";
import { registerCalendarTools } from "./calendar-tools.js";
import { handleGetProfile } from "./profile-tool.js";
import { getDataDir, profileRelPath, getEmptySections, listEvents, findConflicts, getEntity } from "kxta-core";

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

// Resolve target folder for create_file / create_files, enforcing that
// destination='knowledge' declares a `kind` (dictionary or note). If the
// caller also supplied a folder that already targets a known class subfolder
// we honor it verbatim and just flag a warning when it disagrees with kind.
type ResolveKindArgs = { destination: string; folder: string | undefined; kind: "dictionary" | "note" | undefined };
type ResolveKindResult = { folder: string | undefined; warning?: string } | { error: string };
function resolveKindFolder({ destination, folder, kind }: ResolveKindArgs): ResolveKindResult {
  if (destination !== "knowledge") return { folder };
  if (!kind) return { error: "kind is required for destination='knowledge': must be 'dictionary' or 'note'" };

  const norm = folder?.replace(/^\/+|\/+$/g, "") ?? "";
  // Non-KB buckets (html/mermaid) also skip rewrite — their layout forbids nesting under knowledge/.
  const CLASS_PREFIXES = ["knowledge/dictionary", "knowledge/notes", "knowledge/urlclips", "journal", "html", "mermaid"];
  const alreadyClassScoped = CLASS_PREFIXES.some((p) => norm === p || norm.startsWith(p + "/"));

  if (alreadyClassScoped) {
    const impliedDict = norm.startsWith("knowledge/dictionary") || norm.startsWith("knowledge/urlclips");
    const impliedNote = norm.startsWith("knowledge/notes");
    const impliedClass = impliedDict ? "dictionary" : impliedNote ? "note" : null;
    if (impliedClass && impliedClass !== kind) {
      return { folder, warning: `kind='${kind}' but folder targets '${impliedClass}' tree — path wins; content_class will be '${impliedClass}'.` };
    }
    return { folder };
  }

  const classRoot = kind === "dictionary" ? "knowledge/dictionary" : "knowledge/notes";
  return { folder: norm ? `${classRoot}/${norm}` : classRoot };
}

// Format as UTC — server/user timezone divergence would silently mislead otherwise.
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${dd} ${hh}:${mm}Z`;
}

function buildCalendarSection(now: Date): string {
  try {
    const from = now.toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const events = listEvents({ from, to, limit: 3 });
    const conflicts = findConflicts({ from, to }).conflicts;
    const entityName = (id: number) => getEntity(id)?.name ?? `#${id}`;

    const lines: string[] = [];
    lines.push("📅 UPCOMING (next 7 days, times in UTC)");
    if (events.length === 0) {
      lines.push("  (no events)");
    } else {
      for (const e of events) {
        // strip trailing Z from the range endpoint since the header already labels the block UTC
        const from = fmtWhen(e.starts_at).replace(/Z$/, "");
        const to = fmtWhen(e.ends_at).replace(/Z$/, "").slice(11);
        lines.push(`  ${from}–${to}  ${e.title}  (${entityName(e.entity_id)})`);
      }
    }
    if (conflicts.length > 0) {
      lines.push("");
      lines.push(`⚠️ CONFLICTS (${conflicts.length})`);
      for (const c of conflicts.slice(0, 5)) {
        lines.push(`  ${c.kind}: "${c.event_a.title}" (${entityName(c.event_a.entity_id)}) vs "${c.event_b.title}" (${entityName(c.event_b.entity_id)}) — ${c.reason}`);
      }
    }
    return lines.join("\n");
  } catch (e) {
    return `📅 (calendar unavailable: ${(e as Error).message})`;
  }
}

function profileFreshnessNote(profilePath: string, empty: string[]): string {
  const parts: string[] = [];
  if (empty.length > 0) parts.push(`${empty.length} section(s) still empty: ${empty.join(", ")}`);
  try {
    const mtime = statSync(profilePath).mtime;
    const days = Math.floor((Date.now() - mtime.getTime()) / (24 * 60 * 60 * 1000));
    if (days >= 30) parts.push(`profile hasn't been updated in ${days} days`);
  } catch {}
  if (parts.length === 0) return "";
  return `\n\n💡 Reminder: keep your profile current so I can act on it. ${parts.join("; ")}. Edit at knowledge/profile.md or via the dashboard's profile pane.`;
}

// Build the MCP session-instructions blob: welcome, profile, upcoming events, conflicts.
function loadProfileInstructions(): string | undefined {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const path = join(dataDir, profileRelPath());
  const profileExists = existsSync(path);
  const content = profileExists ? readFileSync(path, "utf8").trim() : "";
  const empty = profileExists ? getEmptySections(content) : [];

  const header =
    `👋 Kontexta welcome — ${today}\n\n` +
    `This is the user's session context. Read and honor it for the rest of this session — especially "Session coding style" (comment style, git etiquette, review-before-push) and "Team members and roles" (who's who when writing updates or referencing people).`;

  const profileBlock = profileExists && content
    ? `📋 PROFILE (knowledge/profile.md)\n${content}`
    : `📋 PROFILE\n  (not set up yet — nudge the user to fill it in at knowledge/profile.md or the dashboard's profile pane)`;

  const calendarBlock = buildCalendarSection(now);
  const freshness = profileExists ? profileFreshnessNote(path, empty) : "";

  return [header, "", profileBlock, "", calendarBlock, freshness].filter(Boolean).join("\n");
}

const server = new McpServer(
  { name: "kontexta", version: pkgVersion },
  { instructions: loadProfileInstructions() }
);

server.tool(
  "admin.refresh_session_context",
  "Re-read the session context (profile, upcoming events within 7d, conflicts, freshness nudge) as it stands NOW. Call this when the user just edited their profile or added/moved calendar events and you want the current picture instead of the snapshot taken at session start. Read-only; no side effects. Returns the same block Kontexta sent as MCP instructions at session start.",
  {},
  async () => ({
    content: [{ type: "text", text: loadProfileInstructions() ?? "(no session context available)" }],
  })
);

const handsRegistry = new HandsRegistry(server);

// Initialize journal capture for auto-wrapping all tool calls
const baseJournalDir = join(dataDir, "knowledge", "journal");
const projectSlug = process.env.KONTEXTA_DEFAULT_PROJECT_SLUG ?? "default";
const agent = process.env.KONTEXTA_AGENT ?? "unknown";
const sid = `${process.pid}-${Date.now().toString(36)}`;
initCapture({ projectSlug, baseDir: baseJournalDir, agent, sid });

const distillEngineEnabled = process.env.KONTEXTA_DISTILL_ENGINE !== "off";
const distillEngine = distillEngineEnabled
  ? startDistillEngine({
      dataDir,
      tickMs: Number(process.env.KONTEXTA_DISTILL_TICK_MS) || 5 * 60_000,
      drainOnStart: process.env.KONTEXTA_DISTILL_DRAIN_ON_START !== "false",
      maxEventsPerSlug: Number(process.env.KONTEXTA_DISTILL_MAX_EVENTS) || 500,
    })
  : null;

startGitPoller(process.env.KONTEXTA_PROJECT_PATH ?? process.cwd(), 30);
process.on("exit", shutdownCapture);
// Signal-handler ordering: kill detached Hands children FIRST so their
// process groups receive SIGTERM before this process exits and orphans
// them. shutdownCapture flushes the journal; then drain in-flight ops and close DB.
async function handleShutdownSignal(signal: string) {
  console.warn(`[kontexta-mcp] received ${signal}; draining…`);
  killAllActiveChildren("SIGTERM");
  if (distillEngine) {
    await Promise.race([
      distillEngine.stop({ flush: true }),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }
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

// Auto-wrap every tool registration that follows. journal.write is excluded
// because the auto-wrap re-enters journal recording, and journal.write itself
// records journal events — including it would loop.
const _origServerTool = server.tool.bind(server);
(server as any).tool = function (name: string, ...rest: any[]): any {
  if (name === "journal.write") {
    return (_origServerTool as any)(name, ...rest);
  }
  const handler = rest[rest.length - 1];
  if (typeof handler === "function") {
    rest[rest.length - 1] = wrapHandler(name, handler);
  }
  return (_origServerTool as any)(name, ...rest);
};

// Excluded from wrapHandler (see above) so it does NOT get the
// journal-backlog envelope injected — it IS the journal write path.
server.tool(
  "journal.write",
  "Write one event to the current project's journal. `kind: 'append'` = timestamped entry in today's daily journal file in the Knowledge Base (creates the file if it doesn't exist; both calls on the same calendar day return the same file_id; returns `{file_id}`). `kind: 'note'` = free-form decision/abandonment/observation, stored as an `agent_note` event in Layer 1 (surfaces in distilled task entries; returns `{ok, recorded_at}`). `kind: 'intent'` = topic/intent pivot — use when the user redirects what you're working on so the distillation step splits task buckets correctly (returns `{ok, recorded_at}`). Required fields depend on `kind`: 'append'/'note' need `text`; 'intent' needs `summary`.",
  {
    kind: z.enum(["append", "note", "intent"]).describe("Event kind. Selects which body fields are required and how the event is stored."),
    text: z.string().optional().describe("Required for kind='append' or kind='note'. Body of the entry."),
    summary: z.string().optional().describe("Required for kind='intent'. One-line summary of the new intent."),
    tags: z.array(z.string()).optional().describe("Optional for kind='note'. Tags for the note."),
    project_id: z.number().optional().describe("Optional for kind='append'. Project ID context."),
  },
  async ({ kind, text, summary, tags }: { kind: "append" | "note" | "intent"; text?: string; summary?: string; tags?: string[]; project_id?: number }) => {
    if (kind === "append") {
      if (!text) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "kind='append' requires `text`" }, null, 2) }] };
      }
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

    if (kind === "note") {
      if (!text) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "kind='note' requires `text`" }, null, 2) }] };
      }
      const ev: RawEvent = {
        ts: new Date().toISOString(),
        agent: getCurrentAgent(),
        sid: getCurrentSid(),
        event: "agent_note",
        summary: text,
        tags: tags ?? [],
      };
      appendVoluntaryEvent(ev);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded_at: ev.ts }) }] };
    }

    // kind === "intent"
    if (!summary) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "kind='intent' requires `summary`" }, null, 2) }] };
    }
    const ev: RawEvent = {
      ts: new Date().toISOString(),
      agent: getCurrentAgent(),
      sid: getCurrentSid(),
      event: "user_intent",
      summary,
    };
    appendVoluntaryEvent(ev);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded_at: ev.ts }) }] };
  }
);

server.tool(
  "files.create",
  "Create one or more markdown, mermaid, or HTML files in the knowledge base or project (up to 200 per call). Pass a single-element `files` array for the one-file case. This operation writes each file to disk and adds it to the local SQLite FTS5 index. Destination can be 'knowledge' (global KB), 'project' (reference file inside a project repo), or 'kontexta' (internal Kontexta schema file). If destination is 'project' or 'kontexta', project_id is strictly required. If destination is 'knowledge', 'kind' is strictly required — pick 'dictionary' (authoritative source-of-truth) or 'note' (informational snapshot); see the kind param for the rubric. No external auth required. Rate limits do not apply (local operation). Per-item failures are isolated to `errors[]` — the rest of the batch still commits; a single-item call still reports its failure the same way. Returns `{created_count, error_count, created, errors}`. If a destination directory does not exist, it will be created automatically. To modify an existing file, use 'files.update' instead. Pass format='mmd' on an item to create a Mermaid diagram file (.mmd) or format='html' for HTML reports; defaults to 'md'.",
  {
    files: z
      .array(
        z.object({
          title: z.string().describe("Title of the file"),
          content: z.string().describe("Content of the file"),
          destination: z.enum(["knowledge", "project", "kontexta"]).describe("Destination type"),
          project_id: z.number().optional().describe("Project ID (required for project/kontexta destinations)"),
          folder: z.string().optional().describe("Optional folder path"),
          tags: z.array(z.string()).optional().describe("Optional array of tags"),
          format: z.enum(["md", "mmd", "html"]).optional().describe("File extension to write. Defaults to 'md'. Use 'html' for HTML reports."),
          kind: z.enum(["dictionary", "note"]).optional()
            .describe("REQUIRED for destination='knowledge'. 'dictionary' = source of truth (mappings, glossaries, runbooks, PR templates). 'note' = snapshot (meeting notes, sprint reviews, PR findings, post-mortems). Test: if this file disagreed with the code, who wins? File wins → dictionary; file loses → note. Ignored for destination='project' or 'kontexta'."),
        })
      )
      .min(1)
      .max(200)
      .describe("Files to create. Single-element array = one-file case. Max 200 per call."),
  },
  async ({ files }) => {
    const created: any[] = [];
    const errors: { index: number; title: string; error: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const resolved = resolveKindFolder({ destination: f.destination, folder: f.folder, kind: f.kind });
        if ("error" in resolved) {
          errors.push({ index: i, title: f.title, error: resolved.error });
          continue;
        }
        const result = await createFile({
          title: f.title,
          content: f.content,
          destination: f.destination,
          projectId: f.project_id,
          folder: resolved.folder,
          tags: f.tags,
          dataDir,
          format: f.format,
        });
        const payload: any = annotateTokens(result);
        if (resolved.warning) payload.warning = resolved.warning;
        created.push(payload);
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
  "resources.add_report",
  "Write an image or other binary resource into the shared reports/resources/ folder. Returns { filename, size, src, url } — embed the report's <img>/<a> tags with `src` exactly as given (e.g. `<img src=\"resources/chart.png\">`); it is the only form that resolves correctly both in the dashboard viewer and in PDF/PNG export. Do not use `url` inside report HTML — it only works in the dashboard. Bytes are passed base64-encoded.",
  {
    filename: z.string().describe("Requested filename with extension"),
    bytes_base64: z.string().describe("Base64-encoded file bytes"),
  },
  async ({ filename, bytes_base64 }) => {
    const info = writeResource(dataDir, filename, Buffer.from(bytes_base64, "base64"));
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

server.tool(
  "resources.list_reports",
  "List all files currently stored under reports/resources/. Returns filename, size in bytes, and served URL.",
  {},
  async () => {
    const items = listResources(dataDir);
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

server.tool(
  "resources.delete_report",
  "Delete a file from reports/resources/. No-op if it doesn't exist.",
  { filename: z.string().describe("Filename (relative) of the resource to delete from reports/resources/.") },
  async ({ filename }) => {
    deleteResource(dataDir, filename);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, filename }, null, 2) }] };
  }
);

server.tool(
  "resources.export_report",
  "Export an existing HTML report as PDF or PNG. Returns { url } for the web-served download (requires an authenticated dashboard request) by default. Set inline_bytes=true to render in-process and get { bytes_base64 } instead — only available when running via the full `kontexta` CLI, not the standalone kontexta-mcp package; falls back to { url } with a note if unavailable.",
  {
    id: z.number().describe("File ID of the HTML report to export."),
    format: z.enum(["pdf", "png"]).default("pdf").describe("Output format: 'pdf' or 'png'."),
    inline_bytes: z.boolean().optional().default(false).describe("If true, render in-process and return raw bytes (base64). Only available in the full kontexta CLI bundle; falls back to {url} otherwise."),
  },
  async ({ id, format, inline_bytes }) => {
    const url = `/api/files/${id}/export-html?format=${format}`;
    if (!inline_bytes) return { content: [{ type: "text", text: JSON.stringify({ url }, null, 2) }] };
    try {
      const { readFile } = await import("kxta-core");
      // kxta-publish is intentionally undeclared here (private/workspace-only) — only resolves under the bundled `kontexta` CLI; the catch below covers the standalone package.
      const mod: any = await import("kxta-publish/render/html-export" as any);
      const { join } = await import("node:path");
      const f = readFile(id);
      const bytes = format === "pdf"
        ? await mod.renderHtmlToPdf(f.content, { assetsDir: join(dataDir, "reports", "resources") })
        : await mod.renderHtmlToPng(f.content, { assetsDir: join(dataDir, "reports", "resources") });
      return { content: [{ type: "text", text: JSON.stringify({ bytes_base64: bytes.toString("base64"), format }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: JSON.stringify({ url, note: `inline_bytes unavailable in this install: ${e?.message ?? String(e)}` }, null, 2) }] };
    }
  }
);

server.tool(
  "files.read",
  "Read one or more files, in full or in part. Modes: single-by-id (`id`), single-by-path (`path`, absolute on-disk path — must be exactly as indexed), batch-by-id (`ids`, up to 200), partial-by-heading (`id`+`section`), partial-by-line-range (`id`+`lines`). Exactly one of `id`/`path`/`ids` is required. `section` and `lines` are mutually exclusive and only valid with `id` (not `ids` or `path`). Read-only; no side effects, auth, or rate limits. Response shape: a single file object (with `content`, tags, est_tokens) for `id`/`path`; a partial-content object for `section`/`lines`; `{files, total_est_tokens, error_count, errors}` for `ids` (per-ID failures isolated, batch never partial-throws). Prefer `files.describe` to inspect without paying body tokens.",
  {
    id: z.number().int().positive().optional().describe("Single file by ID."),
    path: z.string().optional().describe("Single file by absolute on-disk path (must match exactly what Kontexta indexed)."),
    ids: z.array(z.number()).min(1).max(200).optional().describe("Batch mode: multiple file IDs (max 200 per call); returns an array plus aggregate token cost."),
    section: z.string().optional().describe("Partial read: return only this heading's body (case-insensitive exact-string after trim). Requires `id`; mutually exclusive with `lines`."),
    lines: z.object({
      from: z.number().int().positive().describe("First line (1-indexed, inclusive)"),
      to: z.number().int().positive().describe("Last line (1-indexed, inclusive)"),
    }).optional().describe("Partial read: 1-indexed inclusive line range. Requires `id`; mutually exclusive with `section`."),
  },
  async ({ id, path, ids, section, lines }) => {
    const modeCount = [id !== undefined, path !== undefined, ids !== undefined].filter(Boolean).length;
    if (modeCount !== 1) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Exactly one of `id`, `path`, or `ids` must be present" }, null, 2) }] };
    }
    if (section !== undefined && lines !== undefined) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "`section` and `lines` are mutually exclusive" }, null, 2) }] };
    }
    if ((section !== undefined || lines !== undefined) && ids !== undefined) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "`section`/`lines` require `id` (single-file mode), not `ids`" }, null, 2) }] };
    }
    if ((section !== undefined || lines !== undefined) && path !== undefined) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "`section`/`lines` require `id`, not `path`" }, null, 2) }] };
    }

    try {
      if (ids !== undefined) {
        const files: any[] = [];
        const errors: { id: number; error: string }[] = [];
        let total_est_tokens = 0;
        for (const rid of ids) {
          try {
            const r = annotateTokens(readFile(rid));
            files.push(r);
            total_est_tokens += r.est_tokens ?? 0;
          } catch (e: any) {
            errors.push({ id: rid, error: e?.message ?? String(e) });
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ files, total_est_tokens, error_count: errors.length, errors }, null, 2) }],
        };
      }

      let resolvedId: number;
      if (path !== undefined) {
        if (path.length === 0) throw new Error("path is required");
        const row = getDatabase().prepare("SELECT id FROM files WHERE path = ?").get(path) as { id: number } | undefined;
        if (!row) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `No file indexed at path: ${path}` }, null, 2) }] };
        }
        resolvedId = row.id;
      } else {
        resolvedId = id!;
      }

      if (section !== undefined) {
        const file = readFile(resolvedId);
        const node = findSection(file.content, section);
        if (!node) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `Section not found: ${section}` }, null, 2) }] };
        }
        const buf = Buffer.from(file.content, "utf8");
        const body = buf.subarray(node.contentStart, node.contentEnd).toString("utf8");
        return {
          content: [{ type: "text", text: JSON.stringify({
            file_id: resolvedId, path: file.path, heading: node.text, level: node.level, line: node.line,
            content: body, size_bytes: Buffer.byteLength(body, "utf8"), est_tokens: estimateTokensFromBuffer(Buffer.from(body, "utf8")),
          }, null, 2) }],
        };
      }

      if (lines !== undefined) {
        if (lines.to < lines.from) throw new Error("`lines.to` must be >= `lines.from`");
        const file = readFile(resolvedId);
        const allLines = file.content.split("\n");
        const start = Math.max(0, lines.from - 1);
        const end = Math.min(allLines.length, lines.to);
        const slice = allLines.slice(start, end).join("\n");
        return {
          content: [{ type: "text", text: JSON.stringify({
            file_id: resolvedId, path: file.path, from: start + 1, to: end, total_lines: allLines.length,
            content: slice, size_bytes: Buffer.byteLength(slice, "utf8"), est_tokens: estimateTokensFromBuffer(Buffer.from(slice, "utf8")),
          }, null, 2) }],
        };
      }

      const result = readFile(resolvedId);
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
  "files.describe",
  "Return everything ABOUT a file without pulling its content (no token cost from the body). Tags, size, est_tokens, history depth, related-file ids, backlinks, project, folder, last edited. Operates locally with no auth or rate limits. Use this when you'd otherwise chain files.read + tags.list + files.get_history + files.find_related just to decide whether to actually read the file. Parameters: 'id' must be a valid integer file ID.",
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
  "files.regex_search",
  "Match a JS regex against file bodies. Default mode scans every file in scope (project, KB, or all) and returns per-file hits with line numbers — slower than FTS `files.search` because it reads each file's content; use only when FTS misses substrings, URLs, or code identifiers. Pass `file_id` to instead scan just that one file (catches what FTS misses within a single known file); response shape changes to `{file_id, path, pattern, match_count, truncated, matches}`. Read-only; no side effects, auth, or rate limits. Multi-file mode capped at 500 files / 10 hits per file by default (`files_truncated` reports the cap); single-file mode capped at 100 hits by default, max 500. `project_id`/`kind` are ignored when `file_id` is set. Invalid regex throws.",
  {
    pattern: z.string().describe("JavaScript RegExp source"),
    file_id: z.number().optional().describe("Scan only this file instead of every file in scope. When set, `project_id`/`kind`/`max_files`/`max_matches_per_file` are ignored in favor of `max_matches`."),
    project_id: z.number().nullable().optional().describe("Scope to one project, null for KB-only, omit for everything. Ignored when `file_id` is set."),
    case_insensitive: z.boolean().optional().describe("If true, match pattern case-insensitively (RegExp 'i' flag). Default false."),
    max_files: z.number().int().positive().max(2000).optional().describe("Cap on files scanned (default 500). Ignored when `file_id` is set."),
    max_matches_per_file: z.number().int().positive().max(100).optional().describe("Per-file hit cap in multi-file mode (default 10). Ignored when `file_id` is set."),
    max_matches: z.number().int().positive().max(500).optional().describe("Cap on returned hits in single-file mode (default 100). Only used when `file_id` is set."),
    kind: z.enum(["dictionary", "note", "journal", "project"]).optional()
      .describe("Filter by content class before scanning. Ignored when `file_id` is set."),
  },
  async ({ pattern, file_id, project_id, case_insensitive, max_files, max_matches_per_file, max_matches, kind }) => {
    try {
      let re: RE2;
      try {
        re = new RE2Class(pattern, case_insensitive ? "i" : "");
      } catch (e: any) {
        throw new Error(`invalid regex: ${e?.message ?? e}`);
      }

      if (file_id !== undefined) {
        const file = readFile(file_id);
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
                  file_id,
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
      }

      const fileCap = max_files ?? 500;
      const perFileCap = max_matches_per_file ?? 10;
      const db = getDatabase();

      const whereParts: string[] = [];
      const params: any[] = [];
      if (project_id === null) {
        whereParts.push("project_id IS NULL");
      } else if (typeof project_id === "number") {
        whereParts.push("project_id = ?");
        params.push(project_id);
      }
      if (kind) {
        whereParts.push("content_class = ?");
        params.push(kind);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
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
  "files.update",
  "Rewrite a file. Default = full-body replacement: `content` becomes the entire file, triggering disk write + FTS5 re-index. Pass `section` to instead rewrite ONLY that heading's body (case-insensitive exact-string after trim; the heading line itself is preserved, siblings untouched) — saves context budget vs resending the whole file. Throws if `section` is set but the heading doesn't exist (this mode will NOT create a new section — append the section text via a full-body update first). Operates locally with no external auth or rate limits. Returns the updated file metadata including new estimated token counts.",
  {
    id: z.number().describe("File ID"),
    content: z.string().describe("New content. With `section` set, this replaces just that heading's body; otherwise it becomes the entire file body."),
    section: z.string().optional().describe("Case-insensitive exact-string heading. When set, only this heading's body is rewritten instead of the whole file."),
  },
  async ({ id, content, section }) => {
    try {
      let newBody = content;
      if (section !== undefined) {
        const file = readFile(id);
        newBody = replaceSection(file.content, section, content);
      }
      const result = await updateFile(id, newBody, dataDir);
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
  "files.delete",
  "DESTRUCTIVE. Permanently delete one or more files by ID (up to 500 per call). Pass a single-element `ids` array for the one-file case. KB files are unlinked from disk AND removed from the FTS5 index; project reference files only have their index entry removed (the file on disk is left alone so the watcher does not fight your editor). Not idempotent — deleting an unknown ID surfaces as a per-item error. No external auth or rate limits. Per-ID failures are isolated to `errors[]` and the rest of the batch still commits — partial success is the norm, always inspect `error_count`. Returns `{deleted_count, error_count, deleted, errors}`. Use only when the file is truly obsolete; to deprioritise without losing data, untag (`tags.remove`) or unfavorite (`tags.set_favorite`) instead. To preview the set before deleting, run `files.list` with the same filter and confirm the IDs.",
  {
    ids: z.array(z.number()).min(1).max(500).describe("File IDs to delete. Single-element array = one-file case. Max 500 per call."),
  },
  async ({ ids }) => {
    const deleted: number[] = [];
    const errors: { id: number; error: string }[] = [];
    for (const id of ids) {
      try {
        await deleteFile(id, dataDir);
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
  "files.list",
  "List file metadata with optional filters (project_id, tag, favorite, folder, untagged, kind) and pagination. Read-only; no side effects, auth, or rate limits. Each row is annotated with tags, est_tokens, size_bytes, and content_class; the response includes `total_est_tokens` so you can budget before reading bodies. `project_id: null` returns ONLY Knowledge Base files; omit the field to span everything; `kind` narrows to one content class. Use to browse known structure; for keyword/content lookup use `files.search`; for a denser whole-vault dump use `projects.map`.",
  {
    project_id: z.number().nullable().optional().describe("Filter by project ID. Pass null to list ONLY Knowledge Base files (project_id IS NULL)."),
    tag: z.string().optional().describe("Filter by tag name"),
    favorite: z.boolean().optional().describe("Filter by favorite status"),
    folder: z.string().optional().describe("Filter by folder path"),
    untagged: z.boolean().optional().describe("If true, return only files that have no tags. Useful for bulk-tagging workflows."),
    limit: z.number().optional().describe("Maximum number of results"),
    offset: z.number().optional().describe("Offset for pagination"),
    kind: z.enum(["dictionary", "note", "journal", "project"]).optional()
      .describe("Filter by content class. dictionary = authoritative KB, note = informational KB, journal = time-log, project = project file."),
  },
  async ({ project_id, tag, favorite, folder, untagged, limit, offset, kind }) => {
    const filters: any = {};
    if (project_id !== undefined) filters.project_id = project_id;
    if (tag !== undefined) filters.tag = tag;
    if (favorite !== undefined) filters.favorite = favorite;
    if (folder !== undefined) filters.folder = folder;
    if (untagged !== undefined) filters.untagged = untagged;
    if (limit !== undefined) filters.limit = limit;
    if (offset !== undefined) filters.offset = offset;
    if (kind !== undefined) filters.content_class = kind;

    const result = listFiles({ dataDir, filters });
    const annotated = attachTags(result.map(annotateTokens));
    const total_est_tokens = annotated.reduce((s, f) => s + (f.est_tokens ?? 0), 0);
    return {
      content: [{ type: "text", text: JSON.stringify({ files: annotated, total_est_tokens }, null, 2) }],
    };
  }
);

server.tool(
  "files.search",
  "Full-text (SQLite FTS5) keyword search across files. Default mode returns ranked matches with inline match_excerpt and title_highlight (no follow-up `files.read` needed for snippets) plus tags, est_tokens, size_bytes, content_class, and aggregate `total_est_tokens`. Pass `include_bodies: true` to instead get a single prompt-ready bundle: matched bodies concatenated into XML `<document>` blocks or markdown headers + fences (see `format`/`max_tokens`), capped at the token budget — files are added in rank order until the next would exceed it, the rest going to `meta.skipped[]`. Use `include_bodies` instead of `files.search` + N×`files.read` when you need several related files as one context blob. Read-only; no side effects, auth, or rate limits. Ordering: dictionary hits sort above everything else for the same query (dictionary-wins on conflict), then BM25 rank. FTS is tokenised: it WILL miss URLs, hyphenated terms, and partial substrings — fall back to `files.regex_search` for those. `project_id: null` searches only the KB; omit the field to span everything; `tags[]` requires ALL listed tags to match; `kind` narrows to one content class.",
  {
    query: z.string().describe("Search query"),
    project_id: z.number().nullable().optional().describe("Filter by project ID. Pass null to search ONLY Knowledge Base files."),
    tags: z.array(z.string()).optional().describe("Filter by tags (all must match)"),
    favorite: z.boolean().optional().describe("Filter by favorite status"),
    kind: z.enum(["dictionary", "note", "journal", "project"]).optional()
      .describe("Filter by content class. dictionary = authoritative KB (system IDs, mappings, glossaries), note = informational KB, journal = time-log, project = project file. Omit to see all classes with dictionary-first ordering."),
    include_bodies: z.boolean().optional().describe("If true, return a single prompt-ready bundle of matched bodies instead of a match list. Response shape changes to `{bundle, meta: {included, skipped, ...}}`. Default false."),
    format: z.enum(["xml", "markdown"]).optional().describe("Bundle format when `include_bodies` is true. xml = Anthropic-recommended <document> tags (default); markdown = ## headers + fenced blocks. Ignored otherwise."),
    max_tokens: z.number().int().positive().optional().describe("Token budget when `include_bodies` is true (default 50000). Files added in rank order until the next would exceed; remainder go to `meta.skipped[]`. Ignored otherwise."),
  },
  async ({ query, project_id, tags, favorite, kind, include_bodies, format, max_tokens }) => {
    const filters: any = { query };
    if (project_id !== undefined) filters.project_id = project_id;
    if (tags !== undefined) filters.tags = tags;
    if (favorite !== undefined) filters.favorite = favorite;
    if (kind !== undefined) filters.content_class = kind;

    if (include_bodies) {
      let bundleResult;
      try {
        bundleResult = await bundleSearch(filters, { format: format ?? "xml", max_tokens: max_tokens ?? 50000 });
      } catch (e: any) {
        if (e instanceof FtsQueryError) {
          return { isError: true, content: [{ type: "text", text: e.message }] };
        }
        throw e;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(bundleResult, null, 2) }],
      };
    }

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
  "tags.add",
  "Append tags to ONE file. Additive — existing tags are preserved; re-adding an existing tag is a no-op (idempotent per tag). New tag names auto-create rows in the global `tags` table. Persists to local SQLite. No external auth or rate limits. Returns `{success: true}`; throws if file_id is unknown. Use to label a single file. To tag every file matching a query in one call use `tags.search`; to remove tags use `tags.remove`.",
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
  "tags.remove",
  "Detach one or more tag IDs from ONE file. Destructive on the link only — does NOT delete the file or the global tag definition (orphan tags survive in `tags.list`). Idempotent: removing an already-absent tag is a no-op. No external auth or rate limits. Returns `{success: true}`. Note: takes tag IDs (integers), not names — fetch them via `tags.list`. To remove ALL tags from many files via a query, see `tags.search` (additive only) — there is no bulk-untag-by-query tool.",
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
  "tags.set_favorite",
  "Set or clear the favorite flag on one file (idempotent — re-setting the same value is a no-op; not a toggle, you pass the desired state). Persists to local SQLite. No external auth or rate limits. Returns `{success: true}`. Use to curate quick-access pins; `files.list` / `files.search` accept `favorite: true` to filter to the pinned set.",
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
  "tags.list",
  "List every tag in the global SQLite database with id, name, and applied count. Read-only; no side effects, auth, or rate limits. Returns the entire taxonomy (not paginated). Use to discover existing labels before tagging (so you reuse rather than fork) or to find tag IDs to feed into `tags.remove`. For tags on a specific file, use `files.describe`.",
  {},
  async () => {
    const result = listTags();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "projects.list",
  "List every registered project with id, name, absolute path, and a derived `has_hands` flag (true when the path exists on disk AND contains a `kontexta.json`). Read-only; no side effects, auth, or rate limits. Use to find the project_id to pass to scoped tools (`files.search`, `files.list`, `admin.commit_backup`, `projects.refresh_index`, etc.). To register a new project use `projects.register`; to inspect its Hands tools use `hands.list`.",
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
  "projects.register",
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
            `Run admin.onboard_agent to refresh the kontexta rules block in-place (your existing project content is preserved).`;
        } else {
          recommendationReason =
            `Found ${detected.join(", ")} with kontexta workflow rules already at the latest version (v${RULE_BLOCK_VERSION}). No action needed — your AI agent will load these rules automatically every session.`;
        }
      } else {
        recommendationReason =
          `No AI agent instructions file (e.g. CLAUDE.md, AGENTS.md, GEMINI.md, ANTIGRAVITY.md, .cursor/rules, .continue/rules, .aider/kontexta.md) was found in this project. ` +
          `These files are how coding agents (Claude Code, Codex, Cursor, Gemini, Aider, etc.) load project-specific context at the start of every session. ` +
          `Without one, your agent won't know this project is registered with kontexta and will skip the search/read/journal workflow — wasting tokens re-reading files it could have looked up. ` +
          `Run admin.onboard_agent with target_agent set to your coding tool to scaffold the right file (CLAUDE.md for Claude Code, .aider/kontexta.md for Aider, etc.) pre-populated with kontexta workflow rules.`;
      }

      const needsOnboarding = outdated.length > 0 || detected.length === 0;
      const recommendation =
        detected.length > 0
          ? {
              kind: "admin.onboard_agent" as const,
              mode: "update" as const,
              reason: recommendationReason,
              target_files: detected,
              next_tool: "admin.onboard_agent" as const,
              next_args: { project_id: project.id },
              prompt:
                outdated.length > 0
                  ? `Update the kontexta rules block in ${detected.join(", ")} to v${RULE_BLOCK_VERSION} now? (Your existing project-specific content above/below the rules block will be left untouched.)`
                  : null,
            }
          : {
              kind: "admin.onboard_agent" as const,
              mode: "create" as const,
              reason: recommendationReason,
              target_files: [] as string[],
              next_tool: "admin.onboard_agent" as const,
              next_args: {
                project_id: project.id,
                target_agent: "<pass your agent: claude-code | codex | gemini | antigravity | cursor | continue | aider | cline | copilot>",
              },
              prompt:
                "Scaffold an AI agent instructions file now? Tell me which agent you use (claude-code, codex, gemini, antigravity, cursor, continue, aider, cline, or copilot) and I'll create the right file (e.g. CLAUDE.md) with the kontexta workflow rules pre-installed, so your agent picks them up on its next session.",
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
  "admin.onboard_agent",
  `Write or update the kontexta workflow rules block in a project's agent context file(s). Idempotent — uses fenced markers + version to skip no-op writes.

MANDATORY: This tool modifies project configuration files. You MUST seek explicit user consent before calling this tool. Set 'confirm: true' only after the user has agreed.

PARAMETERS:
- project_id: number, required.
- confirm: boolean, required. Must be true to proceed.
- files: string[], optional. Paths relative to project root. For update mode, defaults to recommendation.target_files. Ignored when files is empty AND target_agent is provided (create mode).
- target_agent: enum claude-code | codex | gemini | cursor | continue | aider | cline | copilot | generic. Required when files is empty AND no context file currently exists. Picks the canonical filename and the starter scaffold.

RETURNS: { written: [{ path, action: created|updated|skipped, version }], skipped: [{ path, reason }] }`,
  {
    project_id: z.number().describe("Project ID returned from register_project"),
    confirm: z.boolean().describe("MANDATORY: Set to true only after obtaining explicit user consent to modify context files."),
    files: z.array(z.string()).optional().describe("Project-relative paths to update; defaults to detected context files"),
    target_agent: z.enum(["claude-code", "codex", "gemini", "antigravity", "cursor", "continue", "aider", "cline", "copilot", "generic"]).optional()
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
  "admin.transfer_agent_context",
  `COPY existing agent context files (CLAUDE.md, AGENTS.md, .cursor/rules/*.mdc, etc.) from a project's repo into Kontexta's per-project knowledge base so they're indexed by FTS5 and can be git-synced through Kontexta's own backup engine.

This tool ONLY COPIES. It never deletes or modifies the originals in your repo. After a successful transfer, the response includes the list of source paths so the user can manually remove them if desired. No tool argument, no flag, and no code path in this tool ever calls a destructive filesystem operation against \`project.path\`.

MANDATORY: This tool writes new files into Kontexta's data dir. You MUST seek explicit user consent before calling. Set 'confirm: true' only after the user has agreed.

PARAMETERS:
- project_id: number, required. Project ID returned from register_project.
- confirm: boolean, required. Must be true.
- files: string[], optional. Project-relative paths to transfer. Omit or pass [] to transfer all detected agent context files (uses the same detection list as register_project / onboard_agent).

RETURNS: { transferred: [{ source_path, kb_id, kb_path, est_tokens }], skipped: [{ source_path, reason }], next_action }
Skip reasons: "missing" | "symlink" | "outside_project" | "already_transferred_same_content" | "read_error" | "write_error".

IDEMPOTENT: re-running with the same files copies nothing if the content is unchanged — duplicate transfers are detected via SHA-256 hash comparison against existing project KB rows.`,
  {
    project_id: z.number().describe("Project ID returned from register_project"),
    confirm: z.boolean().describe("MANDATORY: Set to true only after obtaining explicit user consent."),
    files: z.array(z.string()).optional().describe("Project-relative paths to transfer. Omit to transfer all detected context files."),
  },
  async ({ project_id, confirm, files }) => {
    try {
      if (confirm !== true) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "User consent required",
              details: "This tool copies project files into Kontexta's KB. Explain the proposed transfer to the user and obtain explicit consent, then re-run with 'confirm: true'. Originals in the project repo are NOT touched."
            }, null, 2)
          }],
        };
      }

      const db = getDatabase();
      const project = db
        .prepare("SELECT id, name, slug, path FROM projects WHERE id = ?")
        .get(project_id) as { id: number; name: string; slug: string; path: string | null } | undefined;
      if (!project || !project.path) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: `Project ${project_id} not found or has no path` }, null, 2) }],
        };
      }

      const projectPath = project.path;
      const targetRels = (files && files.length > 0) ? files : detectAgentContextFiles(projectPath);

      // Pre-load existing project KB content hashes for idempotency check.
      const existingHashes = new Set<string>(
        (db.prepare("SELECT content_hash FROM files WHERE project_id = ? AND storage_type = 'local' AND content_hash IS NOT NULL")
          .all(project.id) as Array<{ content_hash: string }>)
          .map(r => r.content_hash)
      );

      const transferred: Array<{ source_path: string; kb_id: number; kb_path: string; est_tokens: number }> = [];
      const skipped: Array<{ source_path: string; reason: string }> = [];

      for (const rel of targetRels) {
        // Containment check — reject absolute paths, "..", null bytes.
        let abs: string;
        try {
          abs = assertPathInside(projectPath, rel);
        } catch {
          skipped.push({ source_path: rel, reason: "outside_project" });
          continue;
        }

        // Must exist and be a regular file (not a symlink).
        let stat;
        try { stat = lstatSync(abs); } catch { stat = null; }
        if (!stat) { skipped.push({ source_path: rel, reason: "missing" }); continue; }
        if (stat.isSymbolicLink()) { skipped.push({ source_path: rel, reason: "symlink" }); continue; }
        if (!stat.isFile()) { skipped.push({ source_path: rel, reason: "missing" }); continue; }

        let content: string;
        try { content = readFileSync(abs, "utf8"); }
        catch { skipped.push({ source_path: rel, reason: "read_error" }); continue; }

        // Idempotency: skip if same content already exists in this project's KB.
        const hash = createHash("sha256").update(content, "utf8").digest("hex");
        if (existingHashes.has(hash)) {
          skipped.push({ source_path: rel, reason: "already_transferred_same_content" });
          continue;
        }

        // Title derived from the relative path so files from different subdirs
        // don't collide (e.g. CLAUDE.md vs .cursor/rules/CLAUDE.md).
        // slugify() lowercases + replaces non-alphanumerics with dashes.
        const titleSource = rel.replace(/\.[^./]+$/, "");
        const title = titleSource || rel;

        try {
          const created = await createFile({
            title,
            content,
            destination: "kontexta",
            projectId: project.id,
            folder: "agent-context",
            dataDir,
            sourcePath: abs,
          });
          existingHashes.add(hash);
          transferred.push({
            source_path: rel,
            kb_id: created.id,
            kb_path: created.path,
            est_tokens: estimateTokensFromBuffer(Buffer.from(content, "utf8")),
          });
        } catch (e: any) {
          skipped.push({ source_path: rel, reason: `write_error: ${e?.message ?? String(e)}` });
        }
      }

      const next_action = transferred.length > 0
        ? `Copied ${transferred.length} file(s) into Kontexta's KB. Originals in your repo are unchanged. To remove them yourself: ${transferred.map(t => `rm "${join(projectPath, t.source_path)}"`).join(" && ")}`
        : "No files were transferred. See skipped[] for reasons.";

      return {
        content: [{ type: "text", text: JSON.stringify({ transferred, skipped, next_action }, null, 2) }],
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
  "admin.commit_backup",
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
  "resources.clip_url",
  "SIDE-EFFECTFUL — fetches an EXTERNAL URL and writes a NEW KB file. Downloads the page, extracts the main article via Readability, converts to markdown, and saves it under `knowledge/urlclips/`. Auto-classified as content_class='dictionary' (clipped external references are treated as authoritative reference material). NOT idempotent / no de-dup — re-clipping the same URL creates a second file. AUTH: anonymous by default; pass `headers` (e.g. `{Cookie: 'session=...'}` or `{Authorization: 'Bearer ...'}`) to clip behind logins. Kontexta does not rate-limit but the upstream may throttle. On auth-required pages returns isError with `code: AUTH_REQUIRED`, optional `login_url`, and a hint to retry with `headers`. Returns `{file_id, path, title, source}`. Use to ingest external docs into the KB.",
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
  "files.get_history",
  "Return the git commit history for one file (newest first), each entry with hash, message, date, and author. Reads the file's owning repo: the project's git repo for project files, the KB backup repo for KB files. Read-only; no side effects, auth, or rate limits. Returns `{file_id, path, history}`; an empty array means the file has not been committed yet. Use to understand a file's evolution before editing or restoring. Pair with `files.get_diff` to see exact line changes; use `files.restore` to roll back.",
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
  "files.get_diff",
  "Return the unified diff of one file between two commit hashes (typically obtained from `files.get_history` for the same file). Read-only; no side effects, auth, or rate limits. Order matters — `commit_a` is treated as the earlier side; reversing the args inverts the diff. Throws if either hash is unknown to the file's repo. Use after `files.get_history` to see WHAT changed, not just THAT it changed.",
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
  "files.restore",
  "DESTRUCTIVE. Overwrite a file's current on-disk content with the version recorded at a specific git commit, then re-index FTS. The hash MUST come from `files.get_history` for THIS file (foreign hashes throw). The current uncommitted content is lost unless it was already committed elsewhere. The file watcher may also pick up the change before this returns. No external auth or rate limits. Returns `{file_id, path, hash, success, message}`. Use only to undo accidental edits or recover a known-good version.",
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
  "files.read_outline",
  "Return a flat list of markdown headings for one file (level, text, line, byteStart, byteEnd). Read-only; no side effects, auth, or rate limits. Use as a cheap probe before `files.read({ id, section })` or `files.update({ file_id, section, content })` so you don't spend tokens on the full body just to learn what sections exist. Empty outline means the file has no markdown headings (it may still have content — fall back to `files.read` in full or `files.read({ id, lines })`).",
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
  "folders.list",
  "List folder paths under a project root (or the Knowledge Base when `project_id` is null/omitted). Returns `{folders: string[], base_path}` where `folders` are RELATIVE to `base_path`. Read-only; no side effects, auth, or rate limits. Throws if `project_id` references an unknown project. Use to discover where to drop a new file via `files.create`'s `folder` argument or to navigate vault structure; to actually create one use `folders.create`.",
  {
    project_id: z.number().nullable().optional().describe("Project ID. Pass null or omit to list KB folders."),
  },
  async ({ project_id }) => {
    try {
      const base = resolveFolderBase(project_id);
      // Normalize to POSIX so the wire shape matches web /api/folders.
      const folders = listProjectFolders(base).map((f) => f.replace(/\\/g, "/"));
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
  "folders.create",
  "Create a folder under a project root or the KB. Idempotent — creating an existing folder succeeds. Nested paths like `notes/inbox` create intermediates. REJECTS: empty names, null bytes, leading path separators, and any segment equal to `..` (the call returns isError, no folder is touched). Side effect: a directory is mkdir'd on disk; no DB rows are written until a file lands inside. No external auth or rate limits. Returns `{path, base_path}`.",
  {
    project_id: z.number().nullable().optional().describe("Project ID. Pass null or omit to create the folder under the KB."),
    name: z.string().describe("Folder name (relative; supports nested paths via '/')"),
  },
  async ({ project_id, name }) => {
    try {
      validateFolderName(name);
      const base = resolveFolderBase(project_id);
      const path = createFolder(base, name, { dataDir });
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
  "folders.delete",
  "DESTRUCTIVE — recursively delete a folder under the KB AND every file inside it (disk + FTS rows). REFUSES (returns isError) when `project_id` is supplied: deleting inside a registered project would race the file watcher and re-ingest the contents — remove project content via your editor instead. Same name validation as `folders.create`. Not recoverable from Kontexta after the call (only the git backup, if configured, retains it). No external auth or rate limits. Returns `{success: true}`.",
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
      // Refuse deleting a bare bucket name — would wipe the whole bucket and orphan DB rows.
      const KB_BUCKETS_TOP = new Set(["journal", "knowledge", "mermaid", "html"]);
      const segments = name.split(/[/\\]/).filter(Boolean);
      if (segments.length === 1 && KB_BUCKETS_TOP.has(segments[0])) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: `Cannot delete the '${segments[0]}' bucket — part of the fixed KB layout.` }, null, 2) }],
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
  "files.move",
  "Move/rename a file. Destination 'new_path' must be absolute and resolve INSIDE the file's owning project or global knowledge directory. Cross-project moves are rejected. Alternative: pass `kind='dictionary'|'note'` (with no `new_path`) to move a KB file into the mirrored path in the other class tree — subfolder path is preserved. Operates locally with no auth or limits.",
  {
    file_id: z.number().describe("File ID"),
    new_path: z.string().optional().describe("Absolute destination path"),
    kind: z.enum(["dictionary", "note"]).optional()
      .describe("Move the file to the mirrored path in the other class tree. Subfolder path is preserved: knowledge/dictionary/slt/ids.md ↔ knowledge/notes/slt/ids.md. Ignored if `new_path` is also provided."),
  },
  async ({ file_id, new_path, kind }) => {
    try {
      const file = readFile(file_id);

      if (kind && !new_path) {
        if (file.storage_type !== "local") {
          throw new Error("move_file with kind is only supported for KB files (storage_type='local')");
        }
        const kbRoot = join(dataDir, "knowledge");
        const currentRel = relative(kbRoot, file.path);
        const parts = currentRel.split(sep);
        const classIdx = parts.findIndex((p: string) => p === "dictionary" || p === "notes" || p === "urlclips");
        if (classIdx === -1) {
          throw new Error("move_file with kind requires the source to live under knowledge/{dictionary,notes,urlclips}");
        }
        parts[classIdx] = kind === "dictionary" ? "dictionary" : "notes";
        new_path = join(kbRoot, ...parts);
      }

      if (typeof new_path !== "string" || new_path.length === 0) {
        throw new Error("new_path or kind is required");
      }
      if (new_path.includes("\0")) throw new Error("new_path contains null byte");
      if (!isAbsolute(new_path)) throw new Error("new_path must be absolute");
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

      const updated = moveFile(file_id, new_path, dataDir);
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
  "files.find_related",
  "Find other files sharing tags with the given file, ranked by `shared_tag_count` descending. Read-only; no side effects, auth, or rate limits. Returns annotated file rows with `shared_tag_count` and `shared_tags`. Empty result means the file has no tags or no other file shares them — try `files.search`/`files.regex_search` for content-based discovery, or `tags.suggest` to bootstrap labels first. `kind` narrows to one content class. Default limit 10.",
  {
    file_id: z.number().describe("ID of the file to find relations for"),
    limit: z.number().optional().describe("Maximum number of related files to return (default 10)"),
    kind: z.enum(["dictionary", "note", "journal", "project"]).optional()
      .describe("Filter related results to a single content class."),
  },
  async ({ file_id, limit, kind }) => {
    // Post-filter by kind since findRelated has no class filter today; over-fetch
    // when a filter is set so the final result honors `limit` after filtering.
    const overfetch = kind ? Math.max((limit ?? 10) * 4, 40) : (limit ?? 10);
    let related = findRelated(file_id, overfetch);
    if (kind) {
      related = related.filter((r) => r.content_class === kind).slice(0, limit ?? 10);
    }
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
  "tags.search",
  "Bulk-tag — run an FTS `search` and append `add_tags` to every matching file in one call. Side effect: each match gets `addTags` applied (additive, idempotent per tag); the matched files themselves are NOT modified beyond their tag links. Per-file failures isolated to `errors[]`. No external auth or rate limits. There is NO dry-run flag, so ALWAYS run `files.search` with the same query first to verify the match set before tagging. The `tags[]` filter requires existing tags to ALL match (it scopes the search; it does not control which tags get added). Returns `{matched_count, tagged_count, tags_applied, tagged_ids, errors}`.",
  {
    query: z.string().describe("Full-text search query"),
    add_tags: z.array(z.string()).min(1).describe("Tags to add to every matching file"),
    project_id: z.number().nullable().optional().describe("Scope search to a specific project. Pass null for KB-only results."),
    tags: z.array(z.string()).optional().describe("Filter — only matches that already carry ALL of these tags"),
    favorite: z.boolean().optional().describe("If true, restrict to favorited files only."),
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
  "admin.overview",
  "Vault-state snapshot. `mode: 'stats'` = aggregate counts for a scope: `file_count`, `untagged_count`, `favorite_count`, `top_tags`. With `project_id` omitted (everything), also returns `by_project` breakdown. `include_token_total: true` stat()s every matching file on disk to compute a body-size estimate — measurably slower on large vaults; default false. `mode: 'whats_new'` = list files created or modified since a checkpoint (`since`, REQUIRED for this mode — ISO-8601 like `2025-01-15T00:00:00Z` or relative durations like `1h`/`7d`/`2w`; invalid formats throw); CAVEAT: hard-deleted files are NOT surfaced, only mtime-driven changes. Both modes: `project_id: null` = KB only; omit = everything. Read-only; no side effects, auth, or rate limits. Use `stats` as a cheap dashboard or to spot untagged content for cleanup (for live disk-vs-index drift use `files.diff_against_disk`); use `whats_new` at session start to catch up.",
  {
    mode: z.enum(["stats", "whats_new"]).describe("Which snapshot to return. 'whats_new' requires `since`."),
    project_id: z.number().nullable().optional().describe("Filter to a single project. Pass null for KB-only. Omit for everything."),
    top_tags: z.number().int().positive().max(100).optional().describe("mode='stats' only: how many top tags to return (default 10)"),
    include_token_total: z.boolean().optional().describe("mode='stats' only: if true, stat every matching file on disk to compute total est_tokens. Default false (cheap)."),
    since: z.string().optional().describe("REQUIRED for mode='whats_new'. ISO 8601 timestamp or relative duration (e.g. \"1h\", \"7d\", \"2w\")."),
    include_tags: z.boolean().optional().describe("mode='whats_new' only: attach tags[] to each file. Default true."),
    limit: z.number().optional().describe("mode='whats_new' only: max files returned. Default 200."),
  },
  async ({ mode, project_id, top_tags, include_token_total, since, include_tags, limit }) => {
    if (mode === "whats_new") {
      if (!since) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "mode='whats_new' requires `since`" }, null, 2) }] };
      }
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

    // mode === "stats"
    try {
      const db = getDatabase();
      const limitTags = top_tags ?? 10;

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
        .all(...scopeParams, limitTags) as { name: string; count: number }[];

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
  "tags.suggest",
  "Propose tags for a file by mining the existing tag corpus via FTS — picks distinctive terms from the file (≥4 chars, stopword-filtered) and returns tags applied to other files that score high on those terms. No LLM, no network. Already-applied tags are excluded so the suggestions are net-new. Read-only; no side effects, auth, or rate limits. Returns `{file_id, path, existing_tags, suggestions: [{tag, score, sources}]}`. Empty suggestions = no distinctive terms or no overlap with the existing taxonomy yet — bootstrap with `tags.add` first. Default limit 10, max 50. Suggestions are NOT auto-applied.",
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
  "files.diff_against_disk",
  "Diagnose drift between one file's disk content and its FTS index. Status is one of `in_sync`, `diverged`, `disk_unreadable`, or `no_index_row`. On divergence returns sizes, line counts, the first divergent line number, and the disk vs index sample for that line — NOT a full diff (use `files.get_diff` for full diffs between commits). Read-only; no side effects, auth, or rate limits. Use when search results look stale; if status is `diverged` or `no_index_row`, run `projects.refresh_index` to fix.",
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
  "projects.refresh_index",
  "Reconcile the FTS index against disk. For a project (`project_id` set), re-runs `discoverFiles`. For the KB (`project_id` null/omitted), walks `knowledge/`, ingests new .md files, reindexes any whose content hash drifted, and PRUNES rows for files no longer on disk. SIDE-EFFECTFUL: writes/updates/deletes file and FTS rows (the prune is destructive on stale index rows but never deletes files from disk). Idempotent — running twice is a near no-op. Skips files >5MB and standard junk dirs (`node_modules`, `.git`, `dist`, `build`, etc.). No external auth or rate limits. Returns `{scope, newly_indexed, refreshed, pruned}`. Use after editing files outside Kontexta, or when `files.diff_against_disk` reports drift.",
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
  "projects.map",
  "Return a compact indented outline of folders, file titles, tags, and IDs in a single dense block — substantially fewer tokens than the equivalent `files.list` JSON for the same scope. Read-only; no side effects, auth, or rate limits. Capped at `max_lines` (default 5000); the response reports `est_tokens` and emits a `warning` field if it exceeds `KONTEXTA_PROJECT_TOKEN_WARN`. `project_id: null` = KB only; omit = everything. Defaults: include_tags=true, show_titles=true. Use to orient yourself in an unfamiliar vault or project; for keyword lookup use `files.search`.",
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
  "hands.list",
  "List every Hands command tool currently registered, with project scope, tool name, danger level, confirmation flag, and description. Hands tools come from per-project `kontexta.json` files loaded at register time. Pass `schema: true` to instead get the complete `kontexta.json` authoring reference (JSON schema, validation rules, security guarantees, limitations, annotated example) — a static document, unrelated to any specific registered hand. Read-only; no side effects, auth, or rate limits. Use the default list mode to discover what side-effectful project commands the agent is permitted to run; use `schema: true` when helping a user write or fix a `kontexta.json`; reload after editing one with `hands.reload`.",
  {
    schema: z.boolean().optional().describe("If true, return the kontexta.json authoring reference document instead of the registered-hands list. Default false."),
  },
  async ({ schema }) => {
    if (schema) {
      return { content: [{ type: "text", text: buildSchemaDoc() }] };
    }
    const items = handsRegistry.list();
    return { content: [{ type: "text", text: JSON.stringify({ hands: items }, null, 2) }] };
  }
);

server.tool(
  "hands.reload",
  "Re-scan every registered project's `kontexta.json` and rebuild the live Hands tool registry — newly-declared tools become callable immediately, removed tools disappear from `tools/list`. SIDE EFFECT is on the running MCP session's tool inventory only (no disk writes). Idempotent. No external auth or rate limits. Takes no parameters. Returns per-project load results (counts of registered/disabled tools and any validation warnings). Use after editing a `kontexta.json` mid-session; for the schema see `hands.list({ schema: true })`.",
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
  "hands.confirm",
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
  "admin.get_profile",
  "Return the user profile stored in the Knowledge Base. The profile helps AI agents understand the user's context, role, preferences, and goals. Read-only; no side effects, auth, or rate limits. Returns existence status, full content, list of missing required sections, and a hint for new users. Use at session start to understand who you're working with.",
  {},
  async () => {
    const result = handleGetProfile(dataDir);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
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
  registerCalendarTools(server);
  await server.connect(transport);
  console.error("Kontexta MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
