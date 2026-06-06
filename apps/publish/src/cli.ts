import { parseArgs } from "node:util";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfigFile, mergeConfig, type CliOverrides } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { createCoreReader } from "./source/reader.js";

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
    },
    allowPositionals: false,
  });
  return {
    overrides: {
      folders: values.folder as string[] | undefined,
      output: values.output as string | undefined,
      title: values.title as string | undefined,
      brand: values.brand as string | undefined,
    },
    configPath: values.config as string | undefined,
    watch: Boolean(values.watch),
  };
}

export function buildOnce(parsed: ParsedCli): void {
  const file = parsed.configPath && existsSync(parsed.configPath) ? loadConfigFile(parsed.configPath) : {};
  const config = mergeConfig(file, parsed.overrides, { requireFolders: true });
  const { html, report } = runPipeline(config, createCoreReader());
  const out = resolve(config.output);
  writeFileSync(out, html, "utf8");
  console.log(`✓ ${out} — ${report.docCount} docs, ${report.endpointCount} endpoints, ${report.termCount} terms (folders: ${report.folders.join(", ")})`);
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
