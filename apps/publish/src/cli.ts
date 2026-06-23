import { parseArgs } from "node:util";
import { writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { loadConfigFile, mergeConfig, type CliOverrides } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { createCoreReader } from "./source/reader.js";
import { generateLlmsTxt } from "./render/llms.js";

export interface ParsedCli { overrides: CliOverrides; configPath?: string; watch: boolean; }

const VALID_THEMES = new Set(["default", "minimal", "api-ref"]);
type Theme = "default" | "minimal" | "api-ref";

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
  let theme: Theme | undefined;
  if (values.theme != null) {
    const t = String(values.theme);
    if (!VALID_THEMES.has(t)) {
      throw new Error(`Invalid --theme value '${t}'. Expected one of: ${[...VALID_THEMES].join(", ")}.`);
    }
    theme = t as Theme;
  }
  return {
    overrides: {
      folders: values.folder as string[] | undefined,
      output: values.output as string | undefined,
      title: values.title as string | undefined,
      brand: values.brand as string | undefined,
      llmsTxt: Boolean(values.llmsTxt),
      seo: Boolean(values.seo),
      theme,
    },
    configPath: values.config as string | undefined,
    watch: Boolean(values.watch),
  };
}

/** Atomically write `content` to `path`, creating parent dirs as needed. */
let _tmpSeq = 0;
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Unique per call so a leaked tmp from a prior failed rename doesn't get
  // overwritten and so two near-simultaneous writes in the same process
  // can't collide.
  const tmp = `${path}.${process.pid}.${++_tmpSeq}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function buildOnce(parsed: ParsedCli): void {
  let file = {};
  if (parsed.configPath) {
    if (!existsSync(parsed.configPath)) {
      throw new Error(`Config file not found: ${parsed.configPath}`);
    }
    file = loadConfigFile(parsed.configPath);
  }
  const config = mergeConfig(file, parsed.overrides, { requireFolders: true });
  const result = runPipeline(config, createCoreReader());
  const out = resolve(config.output);
  writeFileAtomic(out, result.html);
  console.log(`✓ ${out} — ${result.report.docCount} docs, ${result.report.endpointCount} endpoints, ${result.report.termCount} terms (folders: ${result.report.folders.join(", ")})`);
  if (config.llmsTxt) {
    const llms = generateLlmsTxt(result.docs, result.search, config.site.title);
    writeFileAtomic(join(dirname(out), "llms.txt"), llms);
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
  // Tracks the highest exit code reached across rebuilds — exposed via
  // process.exitCode so a supervisor sees a non-zero status if the watcher
  // is terminated after a streak of failed rebuilds, instead of the silent
  // catch-and-log that used to swallow them entirely.
  let timer: NodeJS.Timeout | null = null;
  const runBuild = () => {
    try {
      buildOnce(parsed);
    } catch (e) {
      console.error("rebuild failed:", (e as Error).message);
      process.exitCode = 1;
    }
  };
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runBuild, 150);
  };
  const watcher = createFileWatcher([knowledgeDir], rebuild);

  // Graceful shutdown: close the watcher and cancel any pending debounce so
  // the process can exit cleanly instead of relying on Node's default
  // SIGINT/SIGTERM handler killing us mid-write.
  const shutdown = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      // createFileWatcher's return shape varies — accept either a function or
      // an object with close()/dispose() without forcing a tight contract.
      const w = watcher as unknown as { close?: () => void; dispose?: () => void } | (() => void);
      if (typeof w === "function") w();
      else if (w?.close) w.close();
      else if (w?.dispose) w.dispose();
    } catch {}
  };
  process.once("SIGINT", () => { shutdown(); process.exit(process.exitCode ?? 0); });
  process.once("SIGTERM", () => { shutdown(); process.exit(process.exitCode ?? 0); });
}
