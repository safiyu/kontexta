import { sep, join, basename } from "node:path";
import { getDatabase } from "../db/index.js";
import { getTagsForFiles } from "../metadata/index.js";
import type { FileRecord, ProjectRecord } from "../types.js";

export interface ProjectMapOptions {
  dataDir: string;
  /**
   * Filter scope:
   *   - undefined / "all": every file in every root
   *   - "knowledge": only files with project_id IS NULL
   *   - { project_id: N }: only that project (use null for knowledge-only)
   */
  project_id?: number | null;
  /** Attach `tags` to each file leaf. Default true. */
  include_tags?: boolean;
  /** Render the title before the filename. Default true. */
  show_titles?: boolean;
  /** Cap output size. Default 5000 lines (one line per file/folder). */
  max_lines?: number;
}

export interface ProjectMapStats {
  files: number;
  folders: number;
  roots: number;
  truncated: boolean;
}

export interface ProjectMapResult {
  /** Indented text outline — the primary payload for agent consumption. */
  outline: string;
  stats: ProjectMapStats;
  /**
   * Token estimate of `outline` (chars/4 heuristic). Lets the caller decide
   * whether the map fits its context budget before passing it along.
   */
  est_tokens: number;
}

interface FileLeaf {
  id: number;
  title: string;
  filename: string;
  tags: string[];
}

interface TreeNode {
  /** Subdirectory name -> child node. */
  dirs: Map<string, TreeNode>;
  files: FileLeaf[];
}

function emptyNode(): TreeNode {
  return { dirs: new Map(), files: [] };
}

/**
 * Strip a known root prefix from an absolute file path. Returns the segments
 * relative to that root, or null if the path doesn't sit under the root.
 */
function stripRoot(filePath: string, root: string): string[] | null {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (filePath === root) return [];
  if (!filePath.startsWith(rootWithSep)) return null;
  return filePath.slice(rootWithSep.length).split(sep).filter(Boolean);
}

interface FileLocation {
  rootLabel: string;
  segments: string[];
}

function locateFile(
  file: FileRecord,
  projectsById: Map<number, ProjectRecord>,
  dataDir: string
): FileLocation {
  if (file.project_id == null) {
    const kbRoot = join(dataDir, "knowledge");
    const segs = stripRoot(file.path, kbRoot);
    return {
      rootLabel: "knowledge",
      segments: segs ?? [basename(file.path)],
    };
  }
  const proj = projectsById.get(file.project_id);
  const rootLabel = `projects/${proj?.slug ?? `id-${file.project_id}`}`;
  // Try project's source path first (storage_type = 'reference').
  if (proj?.path) {
    const segs = stripRoot(file.path, proj.path);
    if (segs) return { rootLabel, segments: segs };
  }
  // Then try the backup subtree (storage_type = 'backup' / 'kontexta').
  if (proj?.slug) {
    const backupRoot = join(dataDir, "projects", proj.slug);
    const segs = stripRoot(file.path, backupRoot);
    if (segs) return { rootLabel, segments: segs };
  }
  return { rootLabel, segments: [basename(file.path)] };
}

function insert(tree: TreeNode, location: FileLocation, leaf: FileLeaf): TreeNode {
  const rootKey = location.rootLabel;
  let rootNode = tree.dirs.get(rootKey);
  if (!rootNode) {
    rootNode = emptyNode();
    tree.dirs.set(rootKey, rootNode);
  }
  let cursor = rootNode;
  // Last segment is the filename; intermediates are folders.
  const folderSegs = location.segments.slice(0, -1);
  for (const seg of folderSegs) {
    let child = cursor.dirs.get(seg);
    if (!child) {
      child = emptyNode();
      cursor.dirs.set(seg, child);
    }
    cursor = child;
  }
  cursor.files.push(leaf);
  return tree;
}

function renderNode(
  node: TreeNode,
  indent: string,
  showTitles: boolean,
  out: string[],
  budget: { maxLines: number }
): { folders: number; files: number } {
  let folders = 0;
  let files = 0;

  // Folders first (sorted), files after (sorted). Easier to scan.
  const dirNames = [...node.dirs.keys()].sort();
  for (const name of dirNames) {
    if (out.length >= budget.maxLines) return { folders, files };
    out.push(`${indent}${name}/`);
    folders++;
    const child = node.dirs.get(name)!;
    const sub = renderNode(child, indent + "  ", showTitles, out, budget);
    folders += sub.folders;
    files += sub.files;
  }

  const sortedFiles = [...node.files].sort((a, b) =>
    (showTitles ? a.title : a.filename).localeCompare(showTitles ? b.title : b.filename)
  );
  for (const f of sortedFiles) {
    if (out.length >= budget.maxLines) return { folders, files };
    const label = showTitles && f.title && f.title !== f.filename ? f.title : f.filename;
    const tagSuffix = f.tags.length ? "  " + f.tags.map((t) => `#${t}`).join(" ") : "";
    out.push(`${indent}[${f.id}] ${label}${tagSuffix}`);
    files++;
  }

  return { folders, files };
}

export function projectMap(opts: ProjectMapOptions): ProjectMapResult {
  const includeTags = opts.include_tags !== false;
  const showTitles = opts.show_titles !== false;
  const maxLines = opts.max_lines ?? 5000;

  const db = getDatabase();
  let sql = "SELECT * FROM files WHERE 1=1";
  const params: unknown[] = [];
  if (opts.project_id !== undefined) {
    if (opts.project_id === null) {
      sql += " AND project_id IS NULL";
    } else {
      sql += " AND project_id = ?";
      params.push(opts.project_id);
    }
  }
  sql += " ORDER BY path ASC";
  const files = db.prepare(sql).all(...params) as FileRecord[];

  const projects = db.prepare("SELECT * FROM projects").all() as ProjectRecord[];
  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const tagsByFileId = includeTags ? getTagsForFiles(files.map((f) => f.id)) : new Map();

  const tree: TreeNode = emptyNode();
  for (const file of files) {
    const location = locateFile(file, projectsById, opts.dataDir);
    const leaf: FileLeaf = {
      id: file.id,
      title: file.title,
      filename: basename(file.path),
      tags: tagsByFileId.get(file.id) ?? [],
    };
    insert(tree, location, leaf);
  }

  const out: string[] = [];
  const budget = { maxLines };
  let totalFolders = 0;
  let totalFiles = 0;
  let roots = 0;

  // Render each root as a top-level group.
  const rootNames = [...tree.dirs.keys()].sort();
  for (const rootName of rootNames) {
    if (out.length >= budget.maxLines) break;
    out.push(`${rootName}/`);
    roots++;
    totalFolders++;
    const sub = renderNode(tree.dirs.get(rootName)!, "  ", showTitles, out, budget);
    totalFolders += sub.folders;
    totalFiles += sub.files;
  }

  const truncated = out.length >= maxLines && (totalFiles < files.length);
  if (truncated) {
    out.push(`... (truncated at ${maxLines} lines; use list_files for full enumeration)`);
  }

  const outline = out.join("\n");
  return {
    outline,
    stats: {
      files: totalFiles,
      folders: Math.max(0, totalFolders - roots), // don't count the root labels themselves
      roots,
      truncated,
    },
    est_tokens: Math.ceil(outline.length / 4),
  };
}
