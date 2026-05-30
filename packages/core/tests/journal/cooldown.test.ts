import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireCooldown, releaseCooldown } from "../../src/journal/cooldown.js";

describe("cooldown", () => {
  let testDir: string;
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), "kontexta-cooldown-")); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("acquires when no lock present", () => {
    const acquired = acquireCooldown(testDir, "p1", 60);
    expect(acquired).toBe(true);
    expect(existsSync(join(testDir, "p1", ".distill.lock"))).toBe(true);
  });

  it("refuses second acquire within cooldown window", () => {
    expect(acquireCooldown(testDir, "p1", 60)).toBe(true);
    expect(acquireCooldown(testDir, "p1", 60)).toBe(false);
  });

  it("releases the lock", () => {
    acquireCooldown(testDir, "p1", 60);
    releaseCooldown(testDir, "p1");
    expect(acquireCooldown(testDir, "p1", 60)).toBe(true);
  });

  it("ignores stale lock past cooldown", async () => {
    acquireCooldown(testDir, "p1", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(acquireCooldown(testDir, "p1", 0)).toBe(true);
  });
});
