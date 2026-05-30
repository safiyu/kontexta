// packages/core/tests/journal/presence.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMcpActive } from "../../src/journal/presence.js";

describe("isMcpActive", () => {
  let testDir: string;
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), "kontexta-presence-")); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("returns false when raw dir does not exist", () => {
    expect(isMcpActive(testDir, "demo", 30)).toBe(false);
  });

  it("returns true when a recent .jsonl exists", () => {
    const dir = join(testDir, "demo", "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-05-12.jsonl"), "{}\n");
    expect(isMcpActive(testDir, "demo", 30)).toBe(true);
  });

  it("returns false when newest .jsonl is past the window", () => {
    const dir = join(testDir, "demo", "raw");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "old.jsonl");
    writeFileSync(f, "{}\n");
    const old = new Date(Date.now() - 600_000);
    utimesSync(f, old, old);
    expect(isMcpActive(testDir, "demo", 30)).toBe(false);
  });
});
