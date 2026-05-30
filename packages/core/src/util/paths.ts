import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Resolves the absolute path to the system default data directory.
 * Falls back to OS-specific standards if KONTEXTA_DATA_DIR is not set.
 */
function defaultDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "kontexta");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "kontexta"
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        "kontexta"
      );
  }
}

/**
 * Returns the active Kontexta data directory.
 * Centralizes path resolution and ensures synchronization between components.
 * 
 * Priority Rules:
 * 1. Web UI Override: If the process is detected as the Web UI and has an override, it WINS.
 * 2. Cached Override: If a path was previously persisted to ~/.kontexta_datadir (e.g. by the Web UI), it WINS.
 * 3. Local Override: If the current process (e.g. MCP) has an override and no cache exists, it is used and cached.
 * 4. OS Default: Fall back to the system standard.
 */
let _resolvedDataDir: string | null = null;

function isWebContext(): boolean {
  return (
    process.env.npm_package_name === "kxta-web" ||
    !!process.env.NEXT_RUNTIME ||
    !!process.env.__NEXT_PAGES_DIR
  );
}

export function getDataDir(): string {
  if (_resolvedDataDir) return _resolvedDataDir;

  const home = os.homedir();
  const cacheFile = path.join(home, ".kontexta_datadir");
  const envOverride = process.env.KONTEXTA_DATA_DIR;
  const isWeb = isWebContext();

  // 1. Web UI Override takes absolute priority and updates the cache
  if (isWeb && envOverride) {
    _resolvedDataDir = path.resolve(envOverride);
    try {
      fs.writeFileSync(cacheFile, _resolvedDataDir, "utf8");
    } catch {}
    return _resolvedDataDir;
  }

  // 2. Check for a persisted "Source of Truth" from a previous run (usually Web UI)
  const isTest = !!process.env.VITEST || process.env.NODE_ENV === "test" || (envOverride && (envOverride.includes("test") || envOverride.includes("tmp")));
  if (!isTest && fs.existsSync(cacheFile)) {
    try {
      const cached = fs.readFileSync(cacheFile, "utf8").trim();
      if (cached && path.isAbsolute(cached)) {
        // Even if this process (MCP) has its own override, we favor the cached one
        // to fulfill the "in case of discrepancy core selects webui override" rule.
        _resolvedDataDir = cached;
        return _resolvedDataDir;
      }
    } catch {}
  }

  // 3. No cache exists. Use the local environment override if set.
  if (envOverride) {
    _resolvedDataDir = path.resolve(envOverride);
    try {
      fs.writeFileSync(cacheFile, _resolvedDataDir, "utf8");
    } catch {}
    return _resolvedDataDir;
  }

  // 4. Default fallthrough
  _resolvedDataDir = defaultDataDir();
  return _resolvedDataDir;
}

/**
 * Returns the active SQLite database path.
 * Respects the KONTEXTA_DB_PATH environment variable override,
 * falling back to the data directory + 'kontexta.db'.
 */
export function getDbPath(): string {
  return process.env.KONTEXTA_DB_PATH || path.join(getDataDir(), "kontexta.db");
}

function safeMkdir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") {
      throw new Error(
        `Kontexta cannot write to data directory: ${dir} (${e.code}). ` +
          `Set KONTEXTA_DATA_DIR to a writable path, or fix permissions on ${dir}.`
      );
    }
    throw e;
  }
}

/**
 * Ensures the data directory and essential subdirectories exist and are writable.
 */
export function ensureDataDir(): void {
  const dataDir = getDataDir();
  
  if (!fs.existsSync(dataDir)) {
    safeMkdir(dataDir);
  }

  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `Kontexta data directory ${dataDir} is not writable. ` +
        `Set KONTEXTA_DATA_DIR to a writable path, or fix permissions.`
    );
  }

  const dirsToCreate = [
    path.join(dataDir, "knowledge"),
    path.join(dataDir, "backups"),
    path.join(dataDir, "projects")
  ];

  for (const dir of dirsToCreate) {
    if (!fs.existsSync(dir)) {
      safeMkdir(dir);
    }
  }
}
