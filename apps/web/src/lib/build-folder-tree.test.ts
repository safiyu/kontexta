import { describe, it, expect } from "vitest";
import { buildFolderTree } from "./build-folder-tree";

const kbBase = "C:\\Users\\safiy\\AppData\\Roaming\\kontexta\\knowledge";
const kbBasePosix = "C:/Users/safiy/AppData/Roaming/kontexta/knowledge";

describe("buildFolderTree", () => {
  it("builds a nested tree from posix paths", () => {
    const files = [
      { id: 1, title: "a", path: `${kbBasePosix}/journal/default/2026/09/a.md` },
      { id: 2, title: "root", path: `${kbBasePosix}/root.md` },
    ];
    const tree = buildFolderTree(files, kbBasePosix);
    expect(tree.files.map((f) => f.title)).toEqual(["root"]);
    expect(tree.children.map((c) => c.name)).toEqual(["journal"]);
    const journal = tree.children[0];
    expect(journal.children.map((c) => c.name)).toEqual(["default"]);
    expect(journal.children[0].children.map((c) => c.name)).toEqual(["2026"]);
    expect(journal.children[0].children[0].children.map((c) => c.name)).toEqual(["09"]);
    expect(journal.children[0].children[0].children[0].files.map((f) => f.id)).toEqual([1]);
    // Node path keys must be forward-slash relative paths.
    expect(journal.path).toBe("journal");
    expect(journal.children[0].path).toBe("journal/default");
  });

  it("builds the same nested tree from Windows backslash paths", () => {
    const files = [
      { id: 1, title: "a", path: `${kbBase}\\journal\\default\\2026\\09\\a.md` },
      { id: 2, title: "root", path: `${kbBase}\\root.md` },
    ];
    // Both base-path spellings must work: the API returns the native join()
    // path (backslash on Windows).
    for (const base of [kbBase, kbBasePosix]) {
      const tree = buildFolderTree(files, base);
      expect(tree.files.map((f) => f.title)).toEqual(["root"]);
      expect(tree.children.map((c) => c.name)).toEqual(["journal"]);
      expect(tree.children[0].path).toBe("journal");
      expect(tree.children[0].children[0].path).toBe("journal/default");
      expect(tree.children[0].children[0].children[0].children[0].files.map((f) => f.id)).toEqual([1]);
    }
  });

  it("injects empty folders with backslash keys as nested nodes, not flat", () => {
    const tree = buildFolderTree([], kbBase, ["journal\\default", "reports"], false);
    expect(tree.children.map((c) => c.name).sort()).toEqual(["journal", "reports"]);
    expect(tree.children.find((c) => c.name === "journal")?.children.map((c) => c.name)).toEqual(["default"]);
  });
});
