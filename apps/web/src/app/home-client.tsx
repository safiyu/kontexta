"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { ThreePane } from "@/components/layout/three-pane";
import { FolderTree } from "@/components/folder-tree/folder-tree";
import { FileList } from "@/components/file-list/file-list";
import { ContentPane } from "@/components/content/content-pane";
import { SearchDialog } from "@/components/search/search-dialog";
import { AboutDialog } from "@/components/about/about-dialog";
import { NewFileDialog } from "@/components/content/new-file-dialog";
import { NewFolderDialog } from "@/components/folder-tree/new-folder-dialog";
import { DeleteFolderDialog } from "@/components/folder-tree/delete-folder-dialog";
import { UnregisterModal } from "@/components/file-list/unregister-modal";
import { DocsModal } from "@/components/docs/docs-modal";
import { PublishDialog } from "@/components/publish/publish-dialog";
import { useProjects } from "@/hooks/use-projects";
import { useFiles } from "@/hooks/use-files";
import { useFolders } from "@/hooks/use-folders";
import { useWebSocket } from "@/hooks/use-websocket";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Breadcrumb, type BreadcrumbSegment } from "@/components/layout/breadcrumb";
import { StatusBar } from "@/components/layout/status-bar";
import { useSyncStatus } from "@/hooks/use-sync-status";
import { IconRail } from "@/components/layout/icon-rail";

type SortBy = "name" | "updated_at" | "created_at";

export default function HomePage() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [deleteFolderConfirmOpen, setDeleteFolderConfirmOpen] = useState(false);
  const [unregisterConfirmOpen, setUnregisterConfirmOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<number | null>(null);
  const [selectedSection, setSelectedSection] = useState<"projects" | "knowledge" | "favorites" | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("updated_at");
  const [folderRefreshKey, setFolderRefreshKey] = useState(0);

  // On first-time setup (?setup=1), auto-open the Configure/Docs modal
  // and immediately clean up the URL so refreshes don't re-trigger it.
  const searchParams = useSearchParams();
  useEffect(() => {
    if (searchParams.get("setup") === "1") {
      setDocsOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("setup");
      window.history.replaceState({}, "", url.toString());
    }
  // Only run once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore navigation state from sessionStorage after mount (avoids SSR hydration mismatch)
  useEffect(() => {
    const storedSection = sessionStorage.getItem("selectedSection") as "projects" | "knowledge" | "favorites" | null;
    const storedProjectId = sessionStorage.getItem("selectedProjectId");
    if (storedSection) setSelectedSection(storedSection);
    if (storedProjectId) setSelectedProjectId(Number(storedProjectId));
  }, []);

  const [globalRemoteUrl, setGlobalRemoteUrl] = useState<string | null>(null);
  const sync = useSyncStatus(globalRemoteUrl);

  const fetchGlobalRemote = useCallback(async () => {
    try {
      const res = await fetch("/api/git/remote");
      if (res.ok) {
        const data = await res.json();
        setGlobalRemoteUrl(data.remote_url);
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    fetchGlobalRemote();
  }, [fetchGlobalRemote]);

  const { projects, loading: projectsLoading, refresh: refreshProjects } = useProjects();

  const handleUnregisterProject = async () => {
    if (!selectedProjectId) return;
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setSelectedProjectId(null);
        setSelectedSection(null);
        setSelectedFolder(null);
        setSelectedFileId(null);
        sessionStorage.removeItem("selectedSection");
        sessionStorage.removeItem("selectedProjectId");
        refreshProjects();
      } else {
        const data = await response.json();
        alert(data.error || "Failed to unregister project");
      }
    } catch (error) {
      console.error("Failed to unregister project:", error);
    }
  };

  // Single global fetch — `allFiles` is the source of truth for both the
  // project view and the KB view. `files` is the project-scoped slice
  // derived in JS to avoid a duplicate /api/files round-trip on every
  // section switch (the previous code ran two near-identical fetches at
  // initial paint).
  const { files: allFiles, loading: filesLoading, refresh: refreshAllFiles } = useFiles({});
  const refreshFiles = refreshAllFiles;
  const files = useMemo(() => {
    if (selectedSection === "favorites") {
      return allFiles.filter((f) => f.favorite);
    }
    if (selectedSection === "projects" && selectedProjectId !== null) {
      return allFiles.filter((f) => f.project_id === selectedProjectId);
    }
    return allFiles;
  }, [allFiles, selectedSection, selectedProjectId]);
  const knowledgeFiles = useMemo(() => allFiles.filter((f) => !f.project_id), [allFiles]);
  const { folders: knowledgeFolders, basePath: knowledgeBasePath } = useFolders(null, folderRefreshKey);
  // Fetch project-specific folders when a project is selected
  const { folders: projectFolders, basePath: projectBasePath } = useFolders(
    selectedSection === "projects" ? selectedProjectId : null,
    folderRefreshKey
  );

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const handleWebSocketEvent = useCallback(
    (_event: { type: string; path: string }) => {
      // Refresh the file lists so the sidebar reflects external changes,
      // but DO NOT toggle selectedFileId. The previous "null then restore"
      // dance reset ContentPane's editing state on every watcher event,
      // silently dropping unsaved edits whenever any .md under data/
      // changed (including unrelated files in other projects).
      refreshAllFiles();
    },
    [refreshAllFiles]
  );

  useWebSocket(handleWebSocketEvent);

  const isPhone = useMediaQuery("(max-width: 767px)");

  // ContentPane reports unsaved-edit state up via onDirtyChange. Selection
  // handlers below check this before discarding the active file so an
  // unintended click can't silently throw away in-progress edits.
  const isDirtyRef = useRef(false);
  const confirmDiscardIfDirty = (): boolean => {
    if (!isDirtyRef.current) return true;
    return window.confirm("You have unsaved changes in the open file. Discard them?");
  };

  // Catches tab close / hard-refresh while editing.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const handleSelectProject = (projectId: number) => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedProjectId(projectId);
    setSelectedSection("projects");
    setSelectedFileId(null);
    setSelectedFolder(null);
    sessionStorage.setItem("selectedSection", "projects");
    sessionStorage.setItem("selectedProjectId", String(projectId));
  };

  const handleSelectKnowledge = () => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedSection("knowledge");
    setSelectedProjectId(null);
    setSelectedFileId(null);
    setSelectedFolder(null);
    sessionStorage.setItem("selectedSection", "knowledge");
    sessionStorage.removeItem("selectedProjectId");
  };

  const handleSelectFavorites = () => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedSection("favorites");
    setSelectedProjectId(null);
    setSelectedFileId(null);
    setSelectedFolder(null);
    sessionStorage.setItem("selectedSection", "favorites");
    sessionStorage.removeItem("selectedProjectId");
  };

  // Atomically switches to KB section AND selects a specific folder
  // (avoids the race where handleSelectKnowledge clears selectedFolder)
  const handleSelectKnowledgeFolder = (folderPath: string | null) => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedSection("knowledge");
    setSelectedProjectId(null);
    setSelectedFileId(null);
    setSelectedFolder(folderPath);
    sessionStorage.setItem("selectedSection", "knowledge");
    sessionStorage.removeItem("selectedProjectId");
  };

  const handleSelectFile = (fileId: number, fromTree?: boolean) => {
    if (fileId !== selectedFileId && !confirmDiscardIfDirty()) return;
    
    const file = allFiles.find((f) => f.id === fileId);
    if (file) {
      // Always sync the section and folder to the file being selected
      if (file.project_id) {
        const proj = projects.find((p) => p.id === file.project_id);
        setSelectedSection("projects");
        setSelectedProjectId(file.project_id);
        sessionStorage.setItem("selectedSection", "projects");
        sessionStorage.setItem("selectedProjectId", String(file.project_id));
        
        // Derive folder from file path relative to project path
        if (proj?.path && file.path.startsWith(proj.path)) {
          const rel = file.path.slice(proj.path.length).replace(/^[\/\\]+/, "");
          const parts = rel.split(/[\/\\]/);
          const folder = parts.slice(0, -1).join("/");
          setSelectedFolder(folder || null);
        } else {
          setSelectedFolder(null);
        }
      } else {
        setSelectedSection("knowledge");
        setSelectedProjectId(null);
        sessionStorage.setItem("selectedSection", "knowledge");
        sessionStorage.removeItem("selectedProjectId");
        
        // Derive KB folder from path relative to <DATA_DIR>/knowledge
        if (knowledgeBasePath && file.path.startsWith(knowledgeBasePath)) {
          const rel = file.path.slice(knowledgeBasePath.length).replace(/^[\/\\]+/, "");
          const parts = rel.split(/[\/\\]/);
          const folder = parts.slice(0, -1).join("/");
          setSelectedFolder(folder || null);
        } else {
          setSelectedFolder(null);
        }
      }
    }

    setSelectedFileId(fileId);
  };

  const handleSelectFolder = (folderPath: string | null) => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedFolder(folderPath);
    setSelectedFileId(null);
  };

  const handleSync = async () => {
    if (!selectedProjectId) return;
    const response = await fetch(`/api/projects/${selectedProjectId}/sync`, {
      method: "POST",
    });
    if (response.ok) {
      refreshFiles();
    } else {
      const data = await response.json();
      throw new Error(data.error || "Sync failed");
    }
  };

  const handleRefresh = async () => {
    console.log("Refreshing index...", { selectedProjectId });
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        body: JSON.stringify({ projectId: selectedProjectId }),
        headers: { "Content-Type": "application/json" },
      });
      if (response.ok) {
        refreshFiles();
        refreshAllFiles();
        setFolderRefreshKey((k) => k + 1);
      } else {
        const data = await response.json();
        alert(data.error || "Refresh failed");
      }
    } catch (error) {
      console.error("Failed to refresh:", error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSyncAll = async () => {
    const response = await fetch("/api/git/sync-all", { method: "POST" });
    if (response.ok || response.status === 207) {
      refreshFiles();
    } else {
      const data = await response.json();
      throw new Error(data.error || "Sync All failed");
    }
  };

  const handleUpdateGlobalRemote = async (url: string) => {
    try {
      const response = await fetch("/api/git/remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remote_url: url }),
      });
      if (response.ok) {
        setGlobalRemoteUrl(url);
      } else {
        throw new Error("Failed to update global remote");
      }
    } catch (error) {
      console.error("Failed to update remote URL:", error);
      throw error;
    }
  };

  const handleSearchSelect = (result: { id: number; path: string; project_id: number | null }) => {
    if (result.id !== selectedFileId && !confirmDiscardIfDirty()) return;
    // Switch the surrounding navigation context to the file's owning
    // section/project so the breadcrumb, file list, and folder tree all
    // line up with the content the user is about to view.
    if (result.project_id) {
      const proj = projects.find((p) => p.id === result.project_id);
      setSelectedSection("projects");
      setSelectedProjectId(result.project_id);
      sessionStorage.setItem("selectedSection", "projects");
      sessionStorage.setItem("selectedProjectId", String(result.project_id));
      // Derive folder from file path relative to project path.
      if (proj?.path && result.path.startsWith(proj.path)) {
        const rel = result.path.slice(proj.path.length).replace(/^[\/\\]+/, "");
        const parts = rel.split(/[\/\\]/);
        const folder = parts.slice(0, -1).join("/");
        setSelectedFolder(folder || null);
      } else {
        setSelectedFolder(null);
      }
    } else {
      setSelectedSection("knowledge");
      setSelectedProjectId(null);
      sessionStorage.setItem("selectedSection", "knowledge");
      sessionStorage.removeItem("selectedProjectId");
      // Derive KB folder from path relative to <DATA_DIR>/knowledge.
      if (knowledgeBasePath && result.path.startsWith(knowledgeBasePath)) {
        const rel = result.path.slice(knowledgeBasePath.length).replace(/^[\/\\]+/, "");
        const parts = rel.split(/[\/\\]/);
        const folder = parts.slice(0, -1).join("/");
        setSelectedFolder(folder || null);
      } else {
        setSelectedFolder(null);
      }
    }
    setSelectedFileId(result.id);
    setSearchOpen(false);
  };

  const handleCreateFile = async (
    title: string,
    content: string,
    destination: "knowledge" | "project" | "kontexta",
    folder?: string
  ) => {
    try {
      const response = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          content,
          destination,
          projectId: selectedProjectId,
          folder,
        }),
      });
      if (response.ok) {
        refreshAllFiles();
        setNewFileOpen(false);
      }
    } catch (error) {
      console.error("Failed to create file:", error);
    }
  };

  const handleDeleteFile = async (fileId: number) => {
    try {
      const response = await fetch(`/api/files/${fileId}`, {
        method: "DELETE",
      });
      if (response.ok) {
        refreshAllFiles();
        setFolderRefreshKey((k) => k + 1);
        setSelectedFileId(null);
      }
    } catch (error) {
      console.error("Failed to delete file:", error);
    }
  };

  const handleCreateFolder = async (name: string) => {
    try {
      const response = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          projectId: targetProjectId && targetProjectId > 0 ? targetProjectId : null, 
          name 
        }),
      });
      if (response.ok) {
        setNewFolderOpen(false);
        // Navigate to the correct section AND into the new folder so the
        // user sees what they just created instead of landing at the root.
        if (!targetProjectId || targetProjectId === 0) {
          setSelectedSection("knowledge");
          setSelectedProjectId(null);
          setSelectedFolder(name);
          sessionStorage.setItem("selectedSection", "knowledge");
          sessionStorage.removeItem("selectedProjectId");
        } else {
          setSelectedFolder(name);
        }
        // Bump the key to trigger folder re-fetch without full page reload
        setFolderRefreshKey((k) => k + 1);
      }
    } catch (error) {
      console.error("Failed to create folder:", error);
    }
  };

  const handleDeleteFolder = () => {
    if (selectedFolder) {
      setDeleteFolderConfirmOpen(true);
    }
  };

  const onConfirmDeleteFolder = async () => {
    if (!selectedFolder) return;
    setDeletingFolder(true);
    try {
      const response = await fetch(`/api/folders?name=${encodeURIComponent(selectedFolder)}&projectId=${selectedProjectId || ""}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setSelectedFolder(null);
        setFolderRefreshKey((k) => k + 1);
        setDeleteFolderConfirmOpen(false);
      } else {
        const data = await response.json();
        alert(data.error || "Failed to delete folder");
      }
    } catch (error) {
      console.error("Failed to delete folder:", error);
    } finally {
      setDeletingFolder(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const breadcrumbSegments: BreadcrumbSegment[] = useMemo(() => {
    const segs: BreadcrumbSegment[] = [];
    if (selectedSection === "favorites") {
      segs.push({ label: "Favorites", onClick: handleSelectFavorites });
    } else if (selectedSection === "knowledge") {
      segs.push({ label: "Knowledge", onClick: handleSelectKnowledge });
    } else if (selectedSection === "projects" && selectedProject) {
      segs.push({ label: selectedProject.name, onClick: () => handleSelectProject(selectedProject.id) });
    }

    const file = selectedFileId
      ? files.find((x) => x.id === selectedFileId) || allFiles.find((x) => x.id === selectedFileId)
      : null;

    const sectionBase =
      selectedSection === "projects"
        ? selectedProject?.path ?? null
        : knowledgeBasePath ?? null;

    let folderSegments: string[] = [];
    if (file && sectionBase && file.path?.startsWith(sectionBase)) {
      const rel = file.path.slice(sectionBase.length).replace(/^\/+/, "");
      const parts = rel.split("/").filter(Boolean);
      folderSegments = parts.slice(0, -1);
    } else if (selectedFolder) {
      folderSegments = selectedFolder.split("/").filter(Boolean);
    }

    folderSegments.forEach((part) => segs.push({ label: part }));
    if (file) segs.push({ label: file.title });
    return segs;
  }, [selectedSection, selectedProject, selectedFileId, files, allFiles, knowledgeBasePath, selectedFolder]);

  const railItems = projects.map((p) => ({
    id: `p-${p.id}`,
    label: p.name,
    active: selectedSection === "projects" && selectedProjectId === p.id,
    onClick: () => handleSelectProject(p.id),
  }));

  const railFooter = {
    id: "kb",
    label: "Knowledge Base",
    active: selectedSection === "knowledge",
    onClick: handleSelectKnowledge,
  };

  if (isPhone) {
    return (
      <div className="h-screen flex flex-col items-center justify-center px-6 text-center bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <div className="text-2xl font-extrabold tracking-[4px] text-[var(--accent)] mb-3">KONTEXTA</div>
        <p className="text-sm text-[var(--text-secondary)] max-w-xs">
          Kontexta is best used on a tablet or larger screen. Open this URL on a wider device to continue.
        </p>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <TopBar
        onSearch={() => setSearchOpen(true)}
        onAbout={() => setAboutOpen(true)}
        onConfigure={() => setDocsOpen(true)}
        onPublish={() => setPublishOpen(true)}
        globalRemoteUrl={globalRemoteUrl}
        syncLog={sync.log}
        onSyncAll={handleSyncAll}
        onUpdateRemote={handleUpdateGlobalRemote}
        selectedProjectName={selectedSection === "projects" ? selectedProject?.name ?? null : null}
        onSyncProject={selectedSection === "projects" && selectedProjectId ? handleSync : undefined}
      />
      <Breadcrumb segments={breadcrumbSegments} />

      <ThreePane
        leftRail={<IconRail items={railItems} footer={railFooter} />}
        left={
          <FolderTree
            projects={projects}
            projectFiles={files}
            knowledgeFiles={knowledgeFiles}
            selectedProjectId={selectedProjectId}
            selectedSection={selectedSection}
            selectedFolder={selectedFolder}
            projectFolders={projectFolders || []}
            knowledgeFolders={knowledgeFolders || []}
            projectBasePath={projectBasePath}
            knowledgeBasePath={knowledgeBasePath}
            onSelectProject={handleSelectProject}
            onSelectKnowledge={handleSelectKnowledge}
            onSelectFavorites={handleSelectFavorites}
            onSelectKnowledgeFolder={handleSelectKnowledgeFolder}
            onSelectFolder={handleSelectFolder}
            onSelectFile={(id) => handleSelectFile(id, true)}
            onCreateFolder={(id) => {
              setTargetProjectId(id);
              setNewFolderOpen(true);
            }}
          />
        }
        middle={
          <FileList
            files={files}
            selectedFileId={selectedFileId}
            onSelectFile={handleSelectFile}
            sortBy={sortBy}
            onSortChange={setSortBy}
            selectedFolder={selectedFolder}
            selectedProject={selectedProject ?? null}
            selectedSection={selectedSection}
            basePath={selectedSection === "projects" ? projectBasePath : knowledgeBasePath}
            loading={filesLoading || projectsLoading}
            onSync={handleSync}
            onUnregisterProject={() => setUnregisterConfirmOpen(true)}
            onDeleteFolder={handleDeleteFolder}
            projects={projects}
            onUploaded={refreshAllFiles}
            onRefresh={handleRefresh}
            refreshing={isRefreshing}
            onNewFile={() => setNewFileOpen(true)}
          />
        }
        right={<ContentPane fileId={selectedFileId} onDelete={handleDeleteFile} onChanged={refreshAllFiles} onDirtyChange={(d) => { isDirtyRef.current = d; }} />}
      />
      <StatusBar
        globalRemoteUrl={globalRemoteUrl}
        status={sync.status}
        lastDoneAt={sync.lastDoneAt}
        stage={sync.stage}
      />

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectFile={handleSearchSelect}
      />

      <AboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
      />

      <DocsModal
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
      />

      <NewFileDialog
        open={newFileOpen}
        onClose={() => setNewFileOpen(false)}
        onCreate={handleCreateFile}
        currentProjectId={selectedProjectId}
        availableFolders={selectedSection === "knowledge" ? knowledgeFolders : projectFolders}
      />

      <NewFolderDialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onCreate={handleCreateFolder}
      />

      <DeleteFolderDialog
        open={deleteFolderConfirmOpen}
        folderName={selectedFolder || ""}
        onClose={() => setDeleteFolderConfirmOpen(false)}
        onConfirm={onConfirmDeleteFolder}
        loading={deletingFolder}
      />

      <UnregisterModal
        isOpen={unregisterConfirmOpen}
        projectName={selectedProject?.name || ""}
        onClose={() => setUnregisterConfirmOpen(false)}
        onConfirm={() => {
          handleUnregisterProject();
          setUnregisterConfirmOpen(false);
        }}
      />

      <PublishDialog
        isOpen={publishOpen}
        onClose={() => setPublishOpen(false)}
      />
    </div>
  );
}
