import { describe, it, expect } from "vitest";
import { enumerateDocs } from "../src/source/enumerate.js";
import type { VaultReader, VaultDoc } from "../src/source/reader.js";

function fakeReader(docs: Record<string, VaultDoc[]>): VaultReader {
  return {
    listFolders: () => Object.keys(docs),
    listDocs: (folder) => (docs[folder] ?? []).map(({ id, path, title }) => ({ id, path, title })),
    read: (id) => {
      for (const list of Object.values(docs)) {
        const hit = list.find((d) => d.id === id);
        if (hit) return hit;
      }
      throw new Error("not found");
    },
  };
}

describe("enumerateDocs", () => {
  it("parses frontmatter and strips it from the body", () => {
    const reader = fakeReader({
      slt: [{ id: 1, path: "/v/slt/02-api.md", title: "02-api",
        content: "---\ntitle: API\norder: 2\n---\n# API\nbody" }],
    });
    const [doc] = enumerateDocs(reader, ["slt"]);
    expect(doc.title).toBe("API");
    expect(doc.frontmatter.order).toBe(2);
    expect(doc.body.trim()).toBe("# API\nbody");
    expect(doc.folder).toBe("slt");
    expect(doc.slug).toBe("02-api");
  });

  it("falls back to first H1 then file title when no frontmatter title", () => {
    const reader = fakeReader({
      slt: [
        { id: 1, path: "/v/slt/a.md", title: "a", content: "# Hello\nx" },
        { id: 2, path: "/v/slt/b.md", title: "b-title", content: "no heading" },
      ],
    });
    const docs = enumerateDocs(reader, ["slt"]);
    expect(docs[0].title).toBe("Hello");
    expect(docs[1].title).toBe("b-title");
  });

  it("only includes requested folders", () => {
    const reader = fakeReader({
      slt: [{ id: 1, path: "/v/slt/a.md", title: "a", content: "# A" }],
      other: [{ id: 2, path: "/v/other/b.md", title: "b", content: "# B" }],
    });
    const docs = enumerateDocs(reader, ["slt"]);
    expect(docs.map((d) => d.id)).toEqual([1]);
  });
});
