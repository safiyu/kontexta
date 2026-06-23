import { realpathSync, existsSync } from "node:fs";
import { resolve, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";

const SYSTEM_PREFIXES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/boot",
  "/var/log",
  "/var/lib",
  "/var/run",
];

function homeSensitivePrefixes(): string[] {
  const home = homedir();
  return [".ssh", ".aws", ".gnupg", ".kube", ".config/gcloud", ".docker"].map(
    (p) => `${home}/${p}`,
  );
}

function startsWithPath(target: string, prefix: string): boolean {
  const t = target.endsWith(sep) ? target : target + sep;
  const p = prefix.endsWith(sep) ? prefix : prefix + sep;
  return t === p || t.startsWith(p);
}

/**
 * Resolve a user-supplied path, following symlinks, and reject if it lands
 * inside a system directory or a sensitive home subtree.
 *
 * Throws on traversal/system paths. Returns the canonical resolved path.
 */
export function assertSafeUserPath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("Invalid path");
  }
  if (p.includes("\0")) {
    throw new Error("Invalid path");
  }
  if (!isAbsolute(p)) {
    throw new Error("Path must be absolute");
  }

  const resolved = resolve(p);
  let canonical = resolved;
  if (existsSync(resolved)) {
    try {
      canonical = realpathSync(resolved);
    } catch {
      canonical = resolved;
    }
  }

  const sensitive = [...SYSTEM_PREFIXES, ...homeSensitivePrefixes()];
  for (const prefix of sensitive) {
    if (startsWithPath(canonical, prefix)) {
      throw new Error(`Path is in a protected system directory: ${prefix}`);
    }
  }

  return canonical;
}

/**
 * For publish output dir: must be writable under dataDir OR pass the same
 * system-path filter (so users can publish to /tmp/docs, ~/sites/foo etc.).
 */
export function assertSafeOutputPath(p: string, dataDir: string): string {
  const canonical = assertSafeUserPath(p);
  const dataCanonical = existsSync(dataDir) ? realpathSync(dataDir) : resolve(dataDir);
  if (startsWithPath(canonical, dataCanonical)) {
    return canonical;
  }
  return canonical;
}
