export interface FolderTreeNode {
  name: string;
  path: string;
  children: FolderTreeNode[];
  files: { id: number; title: string; path: string }[];
  isExplicit?: boolean;
}

// Folder path keys are forward-slash relative paths throughout the UI; normalize native separators.
const toPosix = (p: string): string => p.replace(/\\/g, "/");

export function buildFolderTree(
  files: { id: number; title: string; path: string }[],
  projectPath: string,
  emptyFolders: string[] = [],
  prune: boolean = true
): FolderTreeNode {
  const root: FolderTreeNode = {
    name: "",
    path: "",
    children: [],
    files: [],
  };

  // Server paths use the OS-native separator; backslash paths used to collapse into single flat nodes and drop all files.
  const base = toPosix(projectPath);
  const normalizedProjectPath = base.endsWith("/") ? base : base + "/";

  for (const file of files) {
    // Skip files that don't actually live under this project. A stale row
    // (post-rename, post-misclassification by the watcher) used to render
    // as bogus top-level "/repos/foo/..." nodes when the absolute path
    // was treated as relative.
    const posixPath = toPosix(file.path);
    if (!posixPath.startsWith(normalizedProjectPath)) continue;
    const relativePath = posixPath.slice(normalizedProjectPath.length);

    const segments = relativePath.split("/");
    const fileName = segments.pop()!;

    let current = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = current.children.find((c) => c.name === segment);
      if (!child) {
        child = { name: segment, path: currentPath, children: [], files: [] };
        current.children.push(child);
      }
      current = child;
    }

    current.files.push({ id: file.id, title: file.title, path: file.path });
  }

  // Inject empty folders (posix keys to match the file-derived keys above).
  for (const folderPath of emptyFolders) {
    const segments = toPosix(folderPath).split("/");
    let current = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = current.children.find((c) => c.name === segment);
      if (!child) {
        child = { name: segment, path: currentPath, children: [], files: [] };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Prune nodes that don't have files or non-empty children
  if (prune) {
    pruneEmptyNodes(root);
  }

  sortTree(root);
  return root;
}

function pruneEmptyNodes(node: FolderTreeNode): boolean {
  // Recursively prune children first
  node.children = node.children.filter((child) => pruneEmptyNodes(child));

  // A node is kept if it has files OR has at least one kept child
  return node.files.length > 0 || node.children.length > 0 || !!node.isExplicit;
}

function sortTree(node: FolderTreeNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.title.localeCompare(b.title));
  for (const child of node.children) {
    sortTree(child);
  }
}
