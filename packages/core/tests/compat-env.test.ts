import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("migrateEnvVars", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "MNEXIS_DATA_DIR", "KONTEXTA_DATA_DIR",
    "MNEXIS_DB_PATH", "KONTEXTA_DB_PATH",
    "MNEXIS_WS_HOST", "KONTEXTA_WS_HOST",
    "MNEXIS_WS_ORIGINS", "KONTEXTA_WS_ORIGINS",
    "MNEXIS_WS_TOKEN", "KONTEXTA_WS_TOKEN",
    "MNEXIS_EXPORT_MAX_BYTES", "KONTEXTA_EXPORT_MAX_BYTES",
    "MNEXIS_INSTALL_HINT", "KONTEXTA_INSTALL_HINT",
    "MNEXIS_PROJECT_TOKEN_WARN", "KONTEXTA_PROJECT_TOKEN_WARN",
    "MNEXIS_SHUTDOWN_DRAIN_MS", "KONTEXTA_SHUTDOWN_DRAIN_MS",
  ];

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("copies MNEXIS_* to KONTEXTA_* when new vars unset", async () => {
    process.env.MNEXIS_DATA_DIR = "/old/path";
    process.env.MNEXIS_DB_PATH = "/old/db";
    const { migrateEnvVars } = await import("../src/compat/env-shim.js");
    migrateEnvVars();
    expect(process.env.KONTEXTA_DATA_DIR).toBe("/old/path");
    expect(process.env.KONTEXTA_DB_PATH).toBe("/old/db");
  });

  it("does not overwrite existing KONTEXTA_* values", async () => {
    process.env.MNEXIS_DATA_DIR = "/old";
    process.env.KONTEXTA_DATA_DIR = "/new";
    const { migrateEnvVars } = await import("../src/compat/env-shim.js");
    migrateEnvVars();
    expect(process.env.KONTEXTA_DATA_DIR).toBe("/new");
  });

  it("returns list of migrated variable names", async () => {
    process.env.MNEXIS_WS_HOST = "0.0.0.0";
    const { migrateEnvVars } = await import("../src/compat/env-shim.js");
    const migrated = migrateEnvVars();
    expect(migrated).toContain("MNEXIS_WS_HOST");
  });

  it("returns empty array when nothing to migrate", async () => {
    const { migrateEnvVars } = await import("../src/compat/env-shim.js");
    const migrated = migrateEnvVars();
    expect(migrated).toEqual([]);
  });
});
