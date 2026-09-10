"use client";

import { useMemo, useState, ReactNode } from "react";
import { Folder, CalendarDays, BookText, Workflow, Globe, UserCircle, Tag, ChevronDown, Search, X } from "lucide-react";
import { TreeNode } from "./tree-node";
import { buildFolderTree, FolderTreeNode } from "@/lib/build-folder-tree";
import { EmptyState } from "@/components/ui/empty-state";

interface Project {
  id: number;
  name: string;
  path: string;
  has_hands?: boolean;
}

interface ProjectFile {
  id: number;
  path: string;
  title: string;
}

interface TagCount { id: number; name: string; count: number }

interface FolderTreeProps {
  projects: Project[];
  projectFiles: ProjectFile[];
  knowledgeFiles: ProjectFile[];
  selectedProjectId: number | null;
  selectedSection: "projects" | "knowledge" | "favorites" | "tags" | null;
  selectedFolder: string | null;
  selectedTag: string | null;
  tags: TagCount[];
  projectFolders: string[];
  knowledgeFolders: string[];
  projectBasePath: string;
  knowledgeBasePath: string;
  onSelectProject: (projectId: number) => void;
  onSelectKnowledge: () => void;
  onSelectFavorites: () => void;
  onSelectTag: (tag: string | null) => void;
  onSelectKnowledgeFolder: (folderPath: string | null) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectFile: (fileId: number) => void;
  /** Open the new-folder dialog scoped to a KB bucket (subfolder create). */
  onCreateBucketFolder?: (bucket: string) => void;
}

const FileIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const FolderIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

// Fixed KB layout (4.6.0): only these four folders may sit at knowledge/ root,
// so the pane always renders them — even empty — instead of hiding buckets that
// happen to have no files yet.
const KB_BUCKETS: { name: string; label: string; icon: (props: { className?: string }) => ReactNode }[] = [
  { name: "journal",   label: "Journal",   icon: (p) => <CalendarDays {...p} /> },
  { name: "knowledge", label: "Knowledge", icon: (p) => <BookText {...p} /> },
  { name: "mermaid",   label: "Mermaid",   icon: (p) => <Workflow {...p} /> },
  { name: "html",      label: "HTML",      icon: (p) => <Globe {...p} /> },
];
const KB_BUCKET_NAMES = new Set(KB_BUCKETS.map((b) => b.name));

const TAGS_COLLAPSED_LIMIT = 10;

function TagSection({
  tags,
  selectedTag,
  onSelectTag,
}: {
  tags: TagCount[];
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  // Only expose tags that have at least one file so the browser doesn't fill with orphans.
  const nonEmpty = tags.filter((t) => t.count > 0);
  if (nonEmpty.length === 0) return null;
  const q = query.trim().toLowerCase();
  const filtered = q ? nonEmpty.filter((t) => t.name.toLowerCase().includes(q)) : nonEmpty;
  // Ignore the top-10 cap while searching — users expect the full match set.
  const visible = q || showAll ? filtered : filtered.slice(0, TAGS_COLLAPSED_LIMIT);
  const hidden = filtered.length - visible.length;
  return (
    <div>
      <div className="flex items-center justify-between px-2 pt-2 pb-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[12px] uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors inline-flex items-center gap-1"
          aria-label="Toggle tags"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? "" : "-rotate-90"}`} aria-hidden />
          Tags
          <span className="normal-case tracking-normal text-[var(--text-secondary)]/70">({nonEmpty.length})</span>
        </button>
        {selectedTag && (
          <button
            onClick={() => onSelectTag(null)}
            className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
            title="Clear tag filter"
          >
            Clear
          </button>
        )}
      </div>
      {expanded && (
        <div className="space-y-0.5 mt-0.5">
          <div className="relative px-2 mb-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-secondary)]/60 pointer-events-none" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter tags…"
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md pl-6 pr-6 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/50"
              aria-label="Filter tags"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--accent)]"
                aria-label="Clear tag filter"
                title="Clear"
              >
                <X className="w-3 h-3" aria-hidden />
              </button>
            )}
          </div>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[11px] italic text-[var(--text-secondary)]">
              No tags match &ldquo;{query}&rdquo;.
            </div>
          ) : (
            visible.map((t) => {
              const active = selectedTag === t.name;
              return (
                <button
                  key={t.id}
                  onClick={() => onSelectTag(active ? null : t.name)}
                  className={`w-full flex items-center gap-1.5 py-1 px-2 rounded-lg text-[13px] cursor-pointer transition-all group ${
                    active
                      ? "bg-[var(--accent-soft)] text-[var(--text-primary)] font-semibold"
                      : "text-[var(--text-secondary)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]"
                  }`}
                  aria-pressed={active}
                  title={`Show files tagged "${t.name}"`}
                >
                  <Tag className={`w-3 h-3 shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--text-secondary)] group-hover:text-[var(--accent)]"}`} aria-hidden />
                  <span className="truncate flex-1 text-left lowercase first-letter:uppercase">{t.name}</span>
                  <span className={`text-[10px] font-mono tabular-nums ${active ? "text-[var(--accent)]" : "text-[var(--text-secondary)]/60"}`}>{t.count}</span>
                </button>
              );
            })
          )}
          {!q && hidden > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full text-left px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors italic"
            >
              Show {hidden} more…
            </button>
          )}
          {!q && showAll && nonEmpty.length > TAGS_COLLAPSED_LIMIT && (
            <button
              onClick={() => setShowAll(false)}
              className="w-full text-left px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors italic"
            >
              Show top {TAGS_COLLAPSED_LIMIT}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FolderNodes({
  node,
  selectedFolder,
  onSelectFolder,
  onSelectFile,
}: {
  node: FolderTreeNode;
  selectedFolder: string | null;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectFile: (fileId: number) => void;
}) {
  return (
    <>
      {node.children.map((child) => (
        <TreeNode
          key={child.path}
          label={child.name}
          icon={<FolderIcon className="w-3.5 h-3.5 text-[#FF7F50] group-hover:text-[var(--accent)] transition-colors" />}
          active={selectedFolder === child.path}
          onClick={() => onSelectFolder(child.path)}
        >
          <FolderNodes
            node={child}
            selectedFolder={selectedFolder}
            onSelectFolder={onSelectFolder}
            onSelectFile={onSelectFile}
          />
        </TreeNode>
      ))}
      {node.files.map((file) => (
        <TreeNode
          key={file.id}
          label={file.title}
          icon={<FileIcon className="w-3.5 h-3.5 text-amber-accent group-hover:text-[var(--accent)] transition-colors" />}
          onClick={() => onSelectFile(file.id)}
        />
      ))}
    </>
  );
}

export function FolderTree({
  projects,
  projectFiles,
  knowledgeFiles,
  selectedProjectId,
  selectedSection,
  selectedFolder,
  projectFolders,
  knowledgeFolders,
  projectBasePath,
  knowledgeBasePath,
  onSelectProject,
  onSelectKnowledge,
  onSelectFavorites,
  onSelectKnowledgeFolder,
  onSelectFolder,
  onSelectFile,
  onCreateBucketFolder,
  selectedTag,
  tags,
  onSelectTag,
}: FolderTreeProps) {
  // Tree for Projects
  const projectFolderTree = useMemo(() => {
    if (!selectedProjectId) return null;
    const selectedProject = projects.find((p) => p.id === selectedProjectId);
    if (!selectedProject || !selectedProject.path) return null;
    return buildFolderTree(projectFiles, selectedProject.path, projectFolders);
  }, [selectedProjectId, projectFiles, projectFolders, projects]);

  // Tree for Knowledge Base
  const knowledgeFolderTree = useMemo(() => {
    if (knowledgeFolders.length === 0 && knowledgeFiles.length === 0) return null;
    return buildFolderTree(knowledgeFiles, knowledgeBasePath, knowledgeFolders, false);
  }, [knowledgeFiles, knowledgeFolders, knowledgeBasePath]);

  return (
    <div className="p-2 space-y-3 text-[var(--text-primary)]">
      <div>
        <div className="bp-annotation px-2 pt-2 pb-1 text-[12px] uppercase tracking-wider text-[var(--text-secondary)]">
          Projects
        </div>
        <div className="space-y-0.5">
          {projects.map((project) => {
            const isSelected = selectedProjectId === project.id;
            return (
              <TreeNode
                key={project.id}
                label={project.name}
                icon={<FolderIcon className="w-3.5 h-3.5 text-[#FF7F50] group-hover:text-[var(--accent)] transition-colors" />}
                active={isSelected && selectedFolder === null}
                initialExpanded={isSelected}
                hasHands={project.has_hands}
                onClick={() => {
                  onSelectProject(project.id);
                  onSelectFolder(null);
                }}
              >
                {isSelected && projectFolderTree ? (
                  <FolderNodes
                    node={projectFolderTree}
                    selectedFolder={selectedFolder}
                    onSelectFolder={onSelectFolder}
                    onSelectFile={onSelectFile}
                  />
                ) : undefined}
              </TreeNode>
            );
          })}
          {projects.length === 0 && (
            <EmptyState icon={<Folder className="w-8 h-8 opacity-40" aria-hidden />} title="No projects yet" />
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between px-2 pt-2 pb-1">
          <button
            onClick={onSelectFavorites}
            className={`text-[12px] uppercase tracking-wider transition-colors ${
              selectedSection === "favorites"
                ? "text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            aria-label="Select favorites"
          >
            Favorites
          </button>
        </div>
      </div>

      <TagSection tags={tags} selectedTag={selectedTag} onSelectTag={onSelectTag} />

      <div>
        <div className="px-2 pt-2 pb-1">
          <button
            onClick={onSelectKnowledge}
            className={`text-[12px] uppercase tracking-wider transition-colors ${
              selectedSection === "knowledge" && !selectedFolder
                ? "text-[var(--accent)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            aria-label="Select knowledge base"
          >
            Knowledge
          </button>
        </div>
        <div className="space-y-0.5">
          {(() => {
            // profile.md and any legacy loose files at KB root
            const rootFiles = knowledgeFolderTree?.files ?? [];
            // Case-insensitive match: 'Journal/' on macOS resolves to the 'journal' bucket, not a dupe.
            const bucketByName = new Map<string, FolderTreeNode>();
            for (const child of knowledgeFolderTree?.children ?? []) {
              const lowered = child.name.toLowerCase();
              if (KB_BUCKET_NAMES.has(lowered) && !bucketByName.has(lowered)) {
                bucketByName.set(lowered, child);
              }
            }
            // Anything that isn't one of the four buckets is legacy off-spec —
            // render it below the fixed buckets so it stays visible until
            // migrated, but doesn't muddle the primary layout.
            const legacy = (knowledgeFolderTree?.children ?? []).filter(
              (c) => !KB_BUCKET_NAMES.has(c.name.toLowerCase())
            );
            const emptyBucketNode = (name: string): FolderTreeNode => ({
              name,
              path: name,
              children: [],
              files: [],
            });

            return (
              <>
                {rootFiles.map((file) => {
                  const isProfile = file.path.toLowerCase().endsWith("/profile.md") ||
                    file.path.toLowerCase().endsWith("\\profile.md");
                  return (
                    <TreeNode
                      key={file.id}
                      label={file.title}
                      icon={
                        isProfile ? (
                          <UserCircle className="w-3.5 h-3.5 text-[var(--accent)] group-hover:text-[var(--accent)] transition-colors" />
                        ) : (
                          <FileIcon className="w-3.5 h-3.5 text-amber-accent group-hover:text-[var(--accent)] transition-colors" />
                        )
                      }
                      onClick={() => onSelectFile(file.id)}
                    />
                  );
                })}
                {KB_BUCKETS.map((bucket) => {
                  const node = bucketByName.get(bucket.name) ?? emptyBucketNode(bucket.name);
                  const isEmpty = node.children.length === 0 && node.files.length === 0;
                  return (
                    <TreeNode
                      key={bucket.name}
                      label={bucket.label}
                      icon={bucket.icon({
                        className: `w-3.5 h-3.5 ${isEmpty ? "text-[var(--text-secondary)] opacity-60" : "text-[#FF7F50]"} group-hover:text-[var(--accent)] transition-colors`,
                      })}
                      active={selectedFolder === bucket.name}
                      onClick={() => onSelectKnowledgeFolder(bucket.name)}
                      trailingAction={
                        onCreateBucketFolder ? (
                          <button
                            type="button"
                            onClick={() => onCreateBucketFolder(bucket.name)}
                            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-soft)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
                            title={`New subfolder inside ${bucket.name}/`}
                            aria-label={`New subfolder inside ${bucket.name}`}
                          >
                            +
                          </button>
                        ) : undefined
                      }
                    >
                      {!isEmpty ? (
                        <FolderNodes
                          node={node}
                          selectedFolder={selectedFolder}
                          onSelectFolder={onSelectKnowledgeFolder}
                          onSelectFile={onSelectFile}
                        />
                      ) : undefined}
                    </TreeNode>
                  );
                })}
                {legacy.map((child) => (
                  <TreeNode
                    key={child.path}
                    label={`${child.name} (legacy)`}
                    icon={<FolderIcon className="w-3.5 h-3.5 text-[var(--text-secondary)] opacity-70 group-hover:text-[var(--accent)] transition-colors" />}
                    active={selectedFolder === child.path}
                    onClick={() => onSelectKnowledgeFolder(child.path)}
                  >
                    <FolderNodes
                      node={child}
                      selectedFolder={selectedFolder}
                      onSelectFolder={onSelectKnowledgeFolder}
                      onSelectFile={onSelectFile}
                    />
                  </TreeNode>
                ))}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
