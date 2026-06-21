import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("collects repeated --folder, --output, --config, --watch", () => {
    const a = parseCliArgs(["--folder", "slt", "--folder", "ingest", "--output", "o.html", "--watch"]);
    expect(a.overrides.folders).toEqual(["slt", "ingest"]);
    expect(a.overrides.output).toBe("o.html");
    expect(a.watch).toBe(true);
  });
  it("reads --config path", () => {
    const a = parseCliArgs(["--config", "docs.config.json"]);
    expect(a.configPath).toBe("docs.config.json");
    expect(a.watch).toBe(false);
  });

  it("parses --llmsTxt flag", () => {
    const a = parseCliArgs(["--llmsTxt"]);
    expect(a.overrides.llmsTxt).toBe(true);
  });

  it("parses --seo flag", () => {
    const a = parseCliArgs(["--seo"]);
    expect(a.overrides.seo).toBe(true);
  });

  it("parses --theme flag", () => {
    const a = parseCliArgs(["--theme", "minimal"]);
    expect(a.overrides.theme).toBe("minimal");
  });

  it("parses all new flags together", () => {
    const a = parseCliArgs(["--llmsTxt", "--seo", "--theme", "api-ref"]);
    expect(a.overrides.llmsTxt).toBe(true);
    expect(a.overrides.seo).toBe(true);
    expect(a.overrides.theme).toBe("api-ref");
  });

  it("rejects an unknown --theme value", () => {
    expect(() => parseCliArgs(["--theme", "bogus"])).toThrow(/Invalid --theme/);
  });
});
