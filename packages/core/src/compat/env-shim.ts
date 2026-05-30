const RENAMED_VARS: [string, string][] = [
  ["MNEXIS_DATA_DIR", "KONTEXTA_DATA_DIR"],
  ["MNEXIS_DB_PATH", "KONTEXTA_DB_PATH"],
  ["MNEXIS_WS_HOST", "KONTEXTA_WS_HOST"],
  ["MNEXIS_WS_ORIGINS", "KONTEXTA_WS_ORIGINS"],
  ["MNEXIS_WS_TOKEN", "KONTEXTA_WS_TOKEN"],
  ["MNEXIS_EXPORT_MAX_BYTES", "KONTEXTA_EXPORT_MAX_BYTES"],
  ["MNEXIS_INSTALL_HINT", "KONTEXTA_INSTALL_HINT"],
  ["MNEXIS_PROJECT_TOKEN_WARN", "KONTEXTA_PROJECT_TOKEN_WARN"],
  ["MNEXIS_SHUTDOWN_DRAIN_MS", "KONTEXTA_SHUTDOWN_DRAIN_MS"],
];

export function migrateEnvVars(): string[] {
  const migrated: string[] = [];
  for (const [oldKey, newKey] of RENAMED_VARS) {
    if (process.env[oldKey] && !process.env[newKey]) {
      process.env[newKey] = process.env[oldKey];
      migrated.push(oldKey);
    }
  }
  if (migrated.length > 0) {
    console.warn(
      `[Kontexta] Deprecated env vars migrated: ${migrated.join(", ")}. ` +
        "Rename to KONTEXTA_* prefix. Support removed in v2.0.",
    );
  }
  return migrated;
}
