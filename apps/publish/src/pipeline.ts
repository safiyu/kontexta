import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PublishConfig, RenderedDoc, DocFile } from "./types.js";
import type { VaultReader } from "./source/reader.js";
import { enumerateDocs } from "./source/enumerate.js";
import { renderDocBody } from "./render/markdown.js";
import { buildNav, buildSearchIndex } from "./render/nav.js";
import { assembleShell } from "./template/shell.js";
import { generateLlmsTxt } from "./render/llms.js";
import { createSeedReader } from "./seeds/seeds.js";
import { createCoreReader } from "./source/reader.js";

export interface BuildReport { docCount: number; endpointCount: number; termCount: number; folders: string[]; }

export interface PipelineOutput { relPath: string; content: string; }

/** Render a list of doc files into RenderedDoc[] and produce HTML + report. */
function renderDocs(config: PublishConfig, docFiles: DocFile[]): { html: string; report: BuildReport; docs: RenderedDoc[]; search: import("./types.js").SearchEntry[]; outputs: PipelineOutput[] } {
  const docs: RenderedDoc[] = docFiles.map((doc) => {
    const { html, toc, endpoints, terms } = renderDocBody(doc.body);
    return { doc, html, toc, endpoints, terms };
  });
  const nav = buildNav(docs);
  const search = buildSearchIndex(docs);
  const html = assembleShell({ config, nav, docs, search });
  const outputs: PipelineOutput[] = [{ relPath: "index.html", content: html }];
  if (config.llmsTxt) {
    const llmsTxt = generateLlmsTxt(docs, search, config.site.title);
    outputs.push({ relPath: "llms.txt", content: llmsTxt });
  }
  return {
    html,
    report: {
      docCount: docs.length,
      endpointCount: docs.reduce((n, d) => n + d.endpoints.length, 0),
      termCount: docs.reduce((n, d) => n + (d.terms?.length ?? 0), 0),
      folders: config.source.folders,
    },
    docs,
    search,
    outputs,
  };
}

export function runPipeline(config: PublishConfig, reader?: VaultReader): { html: string; report: BuildReport; docs: RenderedDoc[]; search: import("./types.js").SearchEntry[]; outputs: PipelineOutput[] } {
  const projectPath = config.source.projectPath;
  const vaultReader = reader || createCoreReader({ projectPath });
  const docFiles = enumerateDocs(vaultReader, config.source.folders, projectPath);
  if (docFiles.length === 0) {
    // Fall back to seed docs when no vault documents exist
    const seedReader = createSeedReader();
    const seedDocs = enumerateDocs(seedReader, ["seeds"], projectPath);
    if (seedDocs.length === 0) {
      throw new Error(`No docs found in folders [${config.source.folders.join(", ")}] and no seed docs available.`);
    }
    return renderDocs(config, seedDocs);
  }
  return renderDocs(config, docFiles);
}
