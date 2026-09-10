import { describe, test, expect } from "vitest";
import { bucketOf, formatForFolder, isHtmlResources, acceptForFolder, fileFitsFolder } from "./kb-layout";

describe("kb-layout", () => {
  test("bucketOf recognizes the four buckets under both separators", () => {
    expect(bucketOf("journal")).toBe("journal");
    expect(bucketOf("journal/2026")).toBe("journal");
    expect(bucketOf("journal\\2026")).toBe("journal");
    expect(bucketOf("knowledge/notes/sub")).toBe("knowledge");
    expect(bucketOf("mermaid")).toBe("mermaid");
    expect(bucketOf("html/resources")).toBe("html");
    expect(bucketOf("")).toBeNull();
    expect(bucketOf(null)).toBeNull();
    expect(bucketOf(undefined)).toBeNull();
    expect(bucketOf("random")).toBeNull();
  });

  test("isHtmlResources detects the media subtree", () => {
    expect(isHtmlResources("html/resources")).toBe(true);
    expect(isHtmlResources("html\\resources\\pics")).toBe(true);
    expect(isHtmlResources("html")).toBe(false);
    expect(isHtmlResources("html/reports")).toBe(false);
    expect(isHtmlResources("knowledge/resources")).toBe(false);
  });

  test("formatForFolder maps buckets to their fixed format", () => {
    expect(formatForFolder("journal")).toBe("md");
    expect(formatForFolder("knowledge/topic")).toBe("md");
    expect(formatForFolder("mermaid")).toBe("mmd");
    expect(formatForFolder("html")).toBe("html");
    expect(formatForFolder("html/resources")).toBeNull();
    expect(formatForFolder("html\\resources\\imgs")).toBeNull();
    expect(formatForFolder(null)).toBeNull();
  });

  test("acceptForFolder returns HTML file-input hints per bucket", () => {
    expect(acceptForFolder("journal")).toBe(".md,.markdown");
    expect(acceptForFolder("knowledge/x")).toBe(".md,.markdown");
    expect(acceptForFolder("mermaid")).toBe(".mmd");
    expect(acceptForFolder("html")).toBe(".html,.htm");
    expect(acceptForFolder("html/resources")).toBe("");
    expect(acceptForFolder(null)).toBeNull();
  });

  test("fileFitsFolder accepts matching extensions and rejects others", () => {
    expect(fileFitsFolder("notes.md", "knowledge/topic")).toBe(true);
    expect(fileFitsFolder("notes.MD", "knowledge/topic")).toBe(true);
    expect(fileFitsFolder("readme.markdown", "journal")).toBe(true);
    expect(fileFitsFolder("flow.mmd", "mermaid")).toBe(true);
    expect(fileFitsFolder("flow.md", "mermaid")).toBe(false);
    expect(fileFitsFolder("page.html", "html")).toBe(true);
    expect(fileFitsFolder("page.htm", "html")).toBe(true);
    expect(fileFitsFolder("page.md", "html")).toBe(false);
    expect(fileFitsFolder("pic.png", "html/resources")).toBe(true);
    expect(fileFitsFolder("random.txt", "html/resources/nested")).toBe(true);
    expect(fileFitsFolder("thing.txt", null)).toBe(true);
  });
});
