import { describe, it, expect } from "vitest";
import { mergeConfig, DEFAULT_CONFIG } from "../src/config.js";

describe("mergeConfig", () => {
  it("returns defaults when nothing is provided", () => {
    const cfg = mergeConfig({}, {});
    expect(cfg.output).toBe(DEFAULT_CONFIG.output);
    expect(cfg.site.hero).toBe(true);
    expect(cfg.source.folders).toEqual([]);
  });

  it("file config overrides defaults", () => {
    const cfg = mergeConfig({ source: { folders: ["slt"] }, site: { title: "T" } }, {});
    expect(cfg.source.folders).toEqual(["slt"]);
    expect(cfg.site.title).toBe("T");
    expect(cfg.site.brand).toBe(DEFAULT_CONFIG.site.brand);
  });

  it("CLI flags override file config", () => {
    const cfg = mergeConfig(
      { source: { folders: ["slt"] }, output: "a.html" },
      { folders: ["ingest", "runbooks"], output: "b.html" },
    );
    expect(cfg.source.folders).toEqual(["ingest", "runbooks"]);
    expect(cfg.output).toBe("b.html");
  });

  it("throws when no folders resolved", () => {
    expect(() => mergeConfig({}, {}, { requireFolders: true })).toThrow(/folder/i);
  });

  it("defaults llmsTxt, seo to false and theme to default", () => {
    const cfg = mergeConfig({}, {});
    expect(cfg.llmsTxt).toBe(false);
    expect(cfg.seo).toBe(false);
    expect(cfg.theme).toBe("default");
  });

  it("file config overrides llmsTxt, seo, theme", () => {
    const cfg = mergeConfig(
      { llmsTxt: true, seo: true, theme: "minimal" },
      {},
    );
    expect(cfg.llmsTxt).toBe(true);
    expect(cfg.seo).toBe(true);
    expect(cfg.theme).toBe("minimal");
  });

  it("CLI flags override file config for new fields", () => {
    const cfg = mergeConfig(
      { llmsTxt: false, seo: false, theme: "default" },
      { llmsTxt: true, seo: true, theme: "api-ref" },
    );
    expect(cfg.llmsTxt).toBe(true);
    expect(cfg.seo).toBe(true);
    expect(cfg.theme).toBe("api-ref");
  });
});
