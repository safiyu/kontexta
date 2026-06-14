import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { loadConfigFile, mergeConfig, type CliOverrides } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { createCoreReader } from "./source/reader.js";
import { generateLlmsTxt } from "./render/llms.js";

export interface ParsedCli { overrides: CliOverrides; configPath?: string; watch: boolean; }

export function parseCliArgs(argv: string[]): ParsedCli {
  const { values } = parseArgs({
    args: argv,
    options: {
      folder: { type: "string", multiple: true },
      output: { type: "string" },
      title: { type: "string" },
      brand: { type: "string" },
      config: { type: "string" },
      watch: { type: "boolean", default: false },
      llmsTxt: { type: "boolean", default: false },
      seo: { type: "boolean", default: false },
      theme: { type: "string" },
    },
    allowPositionals: false,
  });
  return {
    overrides: {
      folders: values.folder as string[] | undefined,
      output: values.output as string | undefined,
      title: values.title as string | undefined,
      brand: values.brand as string | undefined,
      llmsTxt: Boolean(values.llmsTxt),
      seo: Boolean(values.seo),
      theme: (values.theme as string) as "default" | "minimal" | "api-ref" | undefined,
    },
    configPath: values.config as string | undefined,
    watch: Boolean(values.watch),
  };
}

export function buildOnce(parsed: ParsedCli): void {
  const file = parsed.configPath && existsSync(parsed.configPath) ? loadConfigFile(parsed.configPath) : {};
  const config = mergeConfig(file, parsed.overrides, { requireFolders: true });
  const result = runPipeline(config, createCoreReader());
  const out = resolve(config.output);
  writeFileSync(out, result.html, "utf8");
  console.log(`✓ ${out} — ${result.report.docCount} docs, ${result.report.endpointCount} endpoints, ${result.report.termCount} terms (folders: ${result.report.folders.join(", ")})`);
  if (config.llmsTxt) {
    const llms = generateLlmsTxt(result.docs, result.search, config.site.title);
    writeFileSync(join(dirname(out), "llms.txt"), llms, "utf8");
    console.log(`  llms.txt — ${result.docs.length} docs indexed`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  buildOnce(parsed);
  if (!parsed.watch) return;

  const { createFileWatcher, getDataDir } = await import("kxta-core");
  const knowledgeDir = join(getDataDir(), "knowledge");
  console.log("watching for changes… (Ctrl+C to stop)");
  let timer: NodeJS.Timeout | null = null;
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try { buildOnce(parsed); } catch (e) { console.error("rebuild failed:", (e as Error).message); }
    }, 150);
  };
  createFileWatcher([knowledgeDir], rebuild);
}
