import { describe, test, expect } from "vitest";
import { computeContentClass } from "../src/content-class/index.js";

const dataDir = "/tmp/kontexta-test-data";

describe("computeContentClass", () => {
  test("storage_type='reference' → 'project' regardless of path", () => {
    expect(
      computeContentClass({
        storageType: "reference",
        path: "/some/project/repo/README.md",
        dataDir,
      })
    ).toBe("project");
  });

  test("storage_type='backup' → 'project'", () => {
    expect(
      computeContentClass({
        storageType: "backup",
        path: "/some/other/path.md",
        dataDir,
      })
    ).toBe("project");
  });

  test("KB file under knowledge/dictionary → 'dictionary'", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/knowledge/dictionary/slt/system-ids.md`,
        dataDir,
      })
    ).toBe("dictionary");
  });

  test("KB file under knowledge/urlclips → 'dictionary'", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/knowledge/urlclips/example.md`,
        dataDir,
      })
    ).toBe("dictionary");
  });

  test("KB file under knowledge/notes → 'note'", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/knowledge/notes/incidents/pprod.md`,
        dataDir,
      })
    ).toBe("note");
  });

  test("KB file under journal → 'journal'", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/journal/2026/09/2026-09-10.md`,
        dataDir,
      })
    ).toBe("journal");
  });

  test("KB file at knowledge root (profile.md) → null (legacy)", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/profile.md`,
        dataDir,
      })
    ).toBeNull();
  });

  test("KB file under knowledge/knowledge but outside named subfolders → null", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/knowledge/misc/scratch.md`,
        dataDir,
      })
    ).toBeNull();
  });

  test("KB file under mermaid/ or html/ → null (legacy)", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/mermaid/architecture.mmd`,
        dataDir,
      })
    ).toBeNull();
    expect(
      computeContentClass({
        storageType: "local",
        path: `${dataDir}/knowledge/html/report.html`,
        dataDir,
      })
    ).toBeNull();
  });

  test("path outside dataDir with storage_type='local' → null (orphan)", () => {
    expect(
      computeContentClass({
        storageType: "local",
        path: "/random/other/path.md",
        dataDir,
      })
    ).toBeNull();
  });
});
