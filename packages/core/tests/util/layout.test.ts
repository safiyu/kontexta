import { describe, test, expect } from "vitest";
import { validateKnowledgeWrite } from "../../src/files/layout.js";

describe("validateKnowledgeWrite - knowledge root allowlist", () => {
  test("allows profile.md at root", () => {
    expect(() => validateKnowledgeWrite("profile.md", "file")).not.toThrow();
  });

  test("rejects any other file at root", () => {
    expect(() => validateKnowledgeWrite("readme.md", "file")).toThrow(/profile\.md/);
    expect(() => validateKnowledgeWrite("note.md", "file")).toThrow(/profile\.md/);
    expect(() => validateKnowledgeWrite("random.txt", "file")).toThrow(/profile\.md/);
  });

  test("allows the four allowed folder names at root", () => {
    for (const name of ["journal", "knowledge", "mermaid", "html"]) {
      expect(() => validateKnowledgeWrite(name, "folder")).not.toThrow();
    }
  });

  test("rejects any other folder at root", () => {
    expect(() => validateKnowledgeWrite("urlclips", "folder")).toThrow(/journal.*knowledge.*mermaid.*html/);
    expect(() => validateKnowledgeWrite("archive", "folder")).toThrow(/journal.*knowledge.*mermaid.*html/);
    expect(() => validateKnowledgeWrite("resources", "folder")).toThrow(/journal.*knowledge.*mermaid.*html/);
  });
});

describe("validateKnowledgeWrite - journal/", () => {
  test("allows .md files at any depth", () => {
    expect(() => validateKnowledgeWrite("journal/2026-09-10.md", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("journal/2026/09/note.md", "file")).not.toThrow();
  });

  test("rejects non-.md files", () => {
    expect(() => validateKnowledgeWrite("journal/note.html", "file")).toThrow(/journal.*\.md/);
    expect(() => validateKnowledgeWrite("journal/note.mmd", "file")).toThrow(/journal.*\.md/);
    expect(() => validateKnowledgeWrite("journal/note.txt", "file")).toThrow(/journal.*\.md/);
    expect(() => validateKnowledgeWrite("journal/sub/thing.png", "file")).toThrow(/journal.*\.md/);
  });

  test("allows arbitrary subfolder names", () => {
    expect(() => validateKnowledgeWrite("journal/anything", "folder")).not.toThrow();
    expect(() => validateKnowledgeWrite("journal/2026/09", "folder")).not.toThrow();
  });
});

describe("validateKnowledgeWrite - knowledge/", () => {
  test("allows .md files at any depth", () => {
    expect(() => validateKnowledgeWrite("knowledge/note.md", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("knowledge/topic/sub/note.md", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("knowledge/urlclips/clip.md", "file")).not.toThrow();
  });

  test("rejects non-.md files", () => {
    expect(() => validateKnowledgeWrite("knowledge/note.mmd", "file")).toThrow(/knowledge.*\.md/);
    expect(() => validateKnowledgeWrite("knowledge/note.html", "file")).toThrow(/knowledge.*\.md/);
  });
});

describe("validateKnowledgeWrite - mermaid/", () => {
  test("allows .mmd files at any depth", () => {
    expect(() => validateKnowledgeWrite("mermaid/flow.mmd", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("mermaid/sub/deep/flow.mmd", "file")).not.toThrow();
  });

  test("rejects non-.mmd files", () => {
    expect(() => validateKnowledgeWrite("mermaid/note.md", "file")).toThrow(/mermaid.*\.mmd/);
    expect(() => validateKnowledgeWrite("mermaid/img.png", "file")).toThrow(/mermaid.*\.mmd/);
  });
});

describe("validateKnowledgeWrite - html/", () => {
  test("allows .html files outside resources/", () => {
    expect(() => validateKnowledgeWrite("html/page.html", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("html/reports/q4.html", "file")).not.toThrow();
  });

  test("rejects non-.html files outside resources/", () => {
    expect(() => validateKnowledgeWrite("html/page.md", "file")).toThrow(/html.*\.html/);
    expect(() => validateKnowledgeWrite("html/pic.png", "file")).toThrow(/html.*\.html/);
    expect(() => validateKnowledgeWrite("html/sub/pic.png", "file")).toThrow(/html.*\.html/);
  });

  test("html/resources/ allows any file type at any depth", () => {
    expect(() => validateKnowledgeWrite("html/resources/pic.png", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("html/resources/doc.pdf", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("html/resources/nested/thing.jpg", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("html/resources/no-extension", "file")).not.toThrow();
  });

  test("allows arbitrary subfolders including resources/", () => {
    expect(() => validateKnowledgeWrite("html/resources", "folder")).not.toThrow();
    expect(() => validateKnowledgeWrite("html/reports", "folder")).not.toThrow();
  });
});

describe("validateKnowledgeWrite - path handling", () => {
  test("rejects empty path", () => {
    expect(() => validateKnowledgeWrite("", "file")).toThrow();
  });

  test("accepts backslash separators", () => {
    expect(() => validateKnowledgeWrite("journal\\note.md", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("html\\resources\\pic.png", "file")).not.toThrow();
  });

  test("extension check is case-insensitive", () => {
    expect(() => validateKnowledgeWrite("journal/note.MD", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("mermaid/flow.MMD", "file")).not.toThrow();
    expect(() => validateKnowledgeWrite("html/page.HTML", "file")).not.toThrow();
  });
});
