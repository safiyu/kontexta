// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { FileList } from "./file-list";

function renderList(extra: Record<string, unknown> = {}) {
  const props = {
    files: [],
    selectedFileId: null,
    onSelectFile: vi.fn(),
    sortBy: "updated_at" as const,
    onSortChange: vi.fn(),
    selectedFolder: null,
    selectedProject: null,
    selectedSection: "knowledge" as const,
    onRefresh: vi.fn(),
    onDeleteFolder: vi.fn(),
    ...extra,
  };
  render(<FileList {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("FileList: folder deletion guard for root knowledge folders", () => {
  it("hides DELETE THIS FOLDER on root knowledge folders (mermaid, knowledge, journal, html)", () => {
    for (const rootFolder of ["mermaid", "knowledge", "journal", "html"]) {
      const { unmount } = render(
        <FileList
          files={[]}
          selectedFileId={null}
          onSelectFile={vi.fn()}
          sortBy="updated_at"
          onSortChange={vi.fn()}
          selectedFolder={rootFolder}
          selectedProject={null}
          selectedSection="knowledge"
          onRefresh={vi.fn()}
          onDeleteFolder={vi.fn()}
        />
      );
      expect(screen.queryByText(/DELETE THIS FOLDER/i)).toBeNull();
      unmount();
    }
  });

  it("shows DELETE THIS FOLDER on non-root subfolders inside knowledge", () => {
    renderList({
      selectedSection: "knowledge",
      selectedFolder: "knowledge/subfolder",
      onDeleteFolder: vi.fn(),
    });
    expect(screen.getByText(/DELETE THIS FOLDER/i)).toBeTruthy();
  });
});
