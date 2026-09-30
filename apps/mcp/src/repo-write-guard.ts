// Anything written through kxta lands in the knowledge base; agents may still write repo files with their own tools.
const WHY = "Nothing created through kxta is written into a project repo — use destination 'knowledge' (the knowledge base) instead.";

export function refuseProjectDestination(destination: string): string | null {
  return destination === "project" ? `destination 'project' is not allowed. ${WHY}` : null;
}

// Project files are indexed as 'reference' storage; files.update/move on them would write into the repo.
export function refuseRepoFile(file: { storage_type: string; project_id: number | null }): string | null {
  return file.storage_type === "reference" && file.project_id ? `This file lives in a project repo and cannot be changed through kxta. ${WHY}` : null;
}

export function refuseProjectFolder(projectId: number | null | undefined): string | null {
  return projectId ? `Folders cannot be created in a project repo through kxta. ${WHY}` : null;
}
