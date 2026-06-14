import { readFileSync } from "node:fs";
import type { PublishConfig } from "./types.js";

export const DEFAULT_CONFIG: PublishConfig = {
  source: { folders: [] },
  site: { title: "Documentation", brand: "", hero: true },
  output: "index.html",
};

/** Partial config as loaded from a docs.config.json file. */
export type FileConfig = Partial<{
  source: Partial<PublishConfig["source"]>;
  site: Partial<PublishConfig["site"]>;
  output: string;
  llmsTxt: boolean;
  seo: boolean;
  theme: "default" | "minimal" | "api-ref";
}>;

/** CLI overrides parsed from flags. */
export interface CliOverrides {
  folders?: string[];
  output?: string;
  title?: string;
  brand?: string;
  llmsTxt?: boolean;
  seo?: boolean;
  theme?: "default" | "minimal" | "api-ref";
}

export function mergeConfig(
  file: FileConfig,
  cli: CliOverrides,
  opts: { requireFolders?: boolean } = {},
): PublishConfig {
  const folders = cli.folders?.length ? cli.folders : file.source?.folders ?? DEFAULT_CONFIG.source.folders;
  const cfg: PublishConfig = {
    source: { folders },
    site: {
      title: cli.title ?? file.site?.title ?? DEFAULT_CONFIG.site.title,
      brand: cli.brand ?? file.site?.brand ?? DEFAULT_CONFIG.site.brand,
      logo: file.site?.logo,
      hero: file.site?.hero ?? DEFAULT_CONFIG.site.hero,
    },
    output: cli.output ?? file.output ?? DEFAULT_CONFIG.output,
    llmsTxt: cli.llmsTxt ?? file.llmsTxt ?? false,
    seo: cli.seo ?? file.seo ?? false,
    theme: cli.theme ?? file.theme ?? "default",
  };
  if (opts.requireFolders && cfg.source.folders.length === 0) {
    throw new Error("No source folders configured. Set source.folders in the config file or pass --folder.");
  }
  return cfg;
}

export function loadConfigFile(path: string): FileConfig {
  return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
}
