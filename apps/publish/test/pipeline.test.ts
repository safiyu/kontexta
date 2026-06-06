import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline.js";
import type { VaultReader, VaultDoc } from "../src/source/reader.js";
import type { PublishConfig } from "../src/types.js";

function reader(): VaultReader {
  const docs: Record<string, VaultDoc[]> = {
    slt: [
      { id: 1, path: "/v/slt/01-overview.md", title: "o",
        content: "---\ntitle: Overview\norder: 1\n---\n# Overview\nWelcome" },
      { id: 2, path: "/v/slt/02-api.md", title: "a",
        content: "---\ntitle: API\norder: 2\n---\n## Auth\n```endpoints\n- method: GET\n  path: /x\n```" },
    ],
  };
  return {
    listFolders: () => Object.keys(docs),
    listDocs: (f) => (docs[f] ?? []).map(({ id, path, title }) => ({ id, path, title })),
    read: (id) => Object.values(docs).flat().find((d) => d.id === id)!,
  };
}

const config: PublishConfig = {
  source: { folders: ["slt"] }, site: { title: "T", brand: "B", hero: true }, output: "out.html",
};

describe("runPipeline", () => {
  it("produces html and a report", () => {
    const { html, report } = runPipeline(config, reader());
    expect(report.docCount).toBe(2);
    expect(report.endpointCount).toBe(1);
    expect(html).toContain("window.__DOCS__");
    expect(html).toContain("Overview");
    expect(html).toContain("api-endpoint");
  });
});
