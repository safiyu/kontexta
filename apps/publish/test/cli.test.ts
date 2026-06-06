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
});
