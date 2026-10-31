// packages/core/src/transfer/index.ts
// Import / export of existing contexts (KB + kontexta-project files) as a single portable archive.
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, sep, basename, extname } from "node:path";
import { getDatabase } from "../db/index.js";
import { createFile, readFile, slugify } from "../files/index.js";
import { setFavorite } from "../metadata/index.js";
import { getTagsForFiles } from "../metadata/index.js";
import type { ContentClass, FileRecord } from "../types.js";

export const ARCHIVE_FORMAT = "kontexta-contexts";
export const ARCHIVE_VERSION = 1;

export interface ArchiveProject {
  name: string;
  slug: string;
  description: string | null;
  remote_url: string | null;
}

export interface ArchiveFile {
  /** Path relative to the data dir, forward slashes (e.g. `knowledge/knowledge/notes/x.md`). */
  path: string;
  title: string;
  /** Slug of the owning kontexta project, or null for Knowledge Base files. */
  project: string | null;
  content_class: ContentClass | null;
  tags: string[];
  favorite: boolean;
  created_at: string;
  updated_at: string;
  content: string;
}

export interface ContextArchive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exported_at: string;
  projects: ArchiveProject[];
  files: ArchiveFile[];
}

export interface ExportOptions {
  dataDir: string;
  /** Only export files belonging to this project slug. */
  project?: string;
  /** Only export KB files (no project). */
  kbOnly?: boolean;
  contentClass?: ContentClass;
  /** Only export files carrying ALL of these tags. */
  tags?: string[];
}

export interface ImportOptions {
  dataDir: string;
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
}

export interface ImportResult {
  dry_run: boolean;
  created: number;
  overwritten: number;
  projects_created: number;
  errors: { path: string; error: string }[];
  written: { path: string; action: "created" | "overwritten" }[];
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Build an in-memory archive of the selected contexts. Only files stored under the data dir are exported. */
export function exportContexts(opts: ExportOptions): ContextArchive {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM files WHERE storage_type = 'local' ORDER BY path")
    .all() as FileRecord[];

  const projects = db.prepare("SELECT id, name, slug, description, remote_url FROM projects").all() as (ArchiveProject & { id: number })[];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const favorites = new Set(
    (db.prepare("SELECT file_id FROM favorites").all() as { file_id: number }[]).map((r) => r.file_id)
  );
  const tagMap = getTagsForFiles(rows.map((r) => r.id));
  const wantTags = opts.tags ?? [];

  const files: ArchiveFile[] = [];
  const usedProjects = new Set<number>();
  for (const r of rows) {
    const rel = relative(opts.dataDir, r.path);
    if (rel.startsWith("..") || rel === "") continue; // outside the data dir
    const project = r.project_id != null ? projectById.get(r.project_id) : undefined;
    if (opts.project && project?.slug !== opts.project) continue;
    if (opts.kbOnly && r.project_id != null) continue;
    if (opts.contentClass && r.content_class !== opts.contentClass) continue;
    const tags = tagMap.get(r.id) ?? [];
    if (wantTags.some((t) => !tags.includes(t))) continue;

    let content: string;
    try {
      content = readFile(r.id).content;
    } catch {
      continue; // row without a readable file on disk
    }
    if (project) usedProjects.add(r.project_id!);
    files.push({
      path: toPosix(rel),
      title: r.title,
      project: project?.slug ?? null,
      content_class: r.content_class,
      tags,
      favorite: favorites.has(r.id),
      created_at: r.created_at,
      updated_at: r.updated_at,
      content,
    });
  }

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: new Date().toISOString(),
    projects: projects
      .filter((p) => usedProjects.has(p.id))
      .map(({ name, slug, description, remote_url }) => ({ name, slug, description, remote_url })),
    files,
  };
}

/** Serialise an archive. A `.gz` suffix on `filePath` gzips the JSON. */
export function writeArchive(archive: ContextArchive, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const json = JSON.stringify(archive, null, 2);
  writeFileSync(filePath, filePath.endsWith(".gz") ? gzipSync(json) : json);
}

/** Read and validate an archive (plain JSON or gzip, detected by magic bytes). */
export function readArchive(filePath: string): ContextArchive {
  let buf = readFileSync(filePath);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  let parsed: any;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("Not a valid kontexta archive: JSON parse failed");
  }
  if (parsed?.format !== ARCHIVE_FORMAT || !Array.isArray(parsed.files)) {
    throw new Error("Not a kontexta contexts archive");
  }
  if (typeof parsed.version !== "number" || parsed.version > ARCHIVE_VERSION) {
    throw new Error(`Unsupported archive version: ${parsed.version} (supported: ${ARCHIVE_VERSION})`);
  }
  return parsed as ContextArchive;
}

function ensureProject(p: ArchiveProject, dataDir: string, dryRun: boolean): { id: number | null; created: boolean } {
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM projects WHERE slug = ?").get(p.slug) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  if (dryRun) return { id: null, created: true };
  const dir = join(dataDir, "projects", p.slug);
  mkdirSync(dir, { recursive: true });
  const r = db
    .prepare("INSERT INTO projects (name, slug, path, description, remote_url) VALUES (?, ?, ?, ?, ?)")
    .run(p.name, p.slug, dir, p.description, p.remote_url);
  return { id: Number(r.lastInsertRowid), created: true };
}

/**
 * Import an archive. Existing files at the same path are overwritten (their tags are merged, favorite is
 * applied). Every file goes through createFile so layout rules, indexing, git and sync still apply.
 */
export async function importContexts(archive: ContextArchive, opts: ImportOptions): Promise<ImportResult> {
  const { dataDir, dryRun = false } = opts;
  const db = getDatabase();
  const result: ImportResult = { dry_run: dryRun, created: 0, overwritten: 0, projects_created: 0, errors: [], written: [] };

  const projectIds = new Map<string, number | null>();
  for (const p of archive.projects ?? []) {
    try {
      const r = ensureProject(p, dataDir, dryRun);
      projectIds.set(p.slug, r.id);
      if (r.created) result.projects_created++;
    } catch (e) {
      result.errors.push({ path: `project:${p.slug}`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const f of archive.files) {
    try {
      if (typeof f.path !== "string" || typeof f.content !== "string") throw new Error("malformed entry");
      const parts = f.path.split("/").filter(Boolean);
      if (parts.some((s) => s === "..")) throw new Error("path escapes data dir");
      const ext = extname(f.path).slice(1);
      if (ext !== "md" && ext !== "mmd" && ext !== "html") throw new Error(`unsupported extension: .${ext}`);
      const stem = basename(f.path, `.${ext}`);

      // createFile derives the filename from slugify(title); keep the original filename when it is slug-safe.
      const title = slugify(stem) === stem ? stem : f.title;

      let destination: "knowledge" | "kontexta";
      let baseDir: string;
      let projectId: number | undefined;
      if (f.project) {
        destination = "kontexta";
        baseDir = join(dataDir, "projects", f.project);
        const pid = projectIds.get(f.project);
        if (pid == null && !dryRun) throw new Error(`project not available: ${f.project}`);
        projectId = pid ?? undefined;
        if (parts[0] !== "projects" || parts[1] !== f.project) throw new Error("path does not match project");
        parts.splice(0, 2);
      } else {
        destination = "knowledge";
        baseDir = join(dataDir, "knowledge");
        if (parts[0] !== "knowledge") throw new Error("path is not under knowledge/");
        parts.splice(0, 1);
      }
      parts.pop();
      const folder = parts.join("/") || undefined;
      const targetPath = join(baseDir, ...(folder ? folder.split("/") : []), `${slugify(title)}.${ext}`);
      const existed = existsSync(targetPath) || !!db.prepare("SELECT 1 FROM files WHERE path = ?").get(targetPath);

      if (!dryRun) {
        const created = await createFile({
          title,
          content: f.content,
          destination,
          projectId,
          folder,
          tags: f.tags ?? [],
          dataDir,
          format: ext,
        });
        if (f.favorite) setFavorite(created.id, true);
      }
      result.written.push({ path: toPosix(relative(dataDir, targetPath)), action: existed ? "overwritten" : "created" });
      if (existed) result.overwritten++;
      else result.created++;
    } catch (e) {
      result.errors.push({ path: f?.path ?? "?", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
