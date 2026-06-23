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

const VALID_THEMES = new Set(["default", "minimal", "api-ref"]);

export function loadConfigFile(path: string): FileConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Config file must be a JSON object: ${path}`);
  }
  const r = raw as Record<string, unknown>;

  if (r.output !== undefined && typeof r.output !== "string") {
    throw new Error(`config.output must be a string`);
  }
  if (r.llmsTxt !== undefined && typeof r.llmsTxt !== "boolean") {
    throw new Error(`config.llmsTxt must be a boolean`);
  }
  if (r.seo !== undefined && typeof r.seo !== "boolean") {
    throw new Error(`config.seo must be a boolean`);
  }
  if (r.theme !== undefined && (typeof r.theme !== "string" || !VALID_THEMES.has(r.theme))) {
    throw new Error(`config.theme must be one of: ${[...VALID_THEMES].join(", ")}`);
  }
  if (r.source !== undefined) {
    if (typeof r.source !== "object" || r.source == null || Array.isArray(r.source)) {
      throw new Error(`config.source must be an object`);
    }
    const src = r.source as Record<string, unknown>;
    if (
      src.folders !== undefined &&
      (!Array.isArray(src.folders) || !src.folders.every((f) => typeof f === "string"))
    ) {
      throw new Error(`config.source.folders must be an array of strings`);
    }
  }
  if (r.site !== undefined) {
    if (typeof r.site !== "object" || r.site == null || Array.isArray(r.site)) {
      throw new Error(`config.site must be an object`);
    }
  }
  return raw as FileConfig;
}
