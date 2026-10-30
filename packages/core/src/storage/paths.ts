import { isAbsolute, relative, resolve, sep } from "node:path";
import { getDataDir } from "../util/paths.js";
import { assertPathInside } from "../util/safety.js";
import { UnappliableOpError } from "./errors.js";

/** Path relative to this machine's data dir (forward slashes), or null when outside it. */
export function toRelPath(absPath: string): string | null {
  const rel = relative(resolve(getDataDir()), resolve(absPath));
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** True when `absPath` lives inside this machine's data dir, the only place file ops sync. */
export function isSyncablePath(absPath: string): boolean {
  return toRelPath(absPath) !== null;
}

/** Map a remote op's path onto this machine's data dir; never returns a path outside it. */
export function resolveSyncPath(absPath: unknown, relPath: unknown): string {
  const base = resolve(getDataDir());
  try {
    if (typeof relPath === "string" && relPath !== "") return assertPathInside(base, relPath);
    if (typeof absPath === "string" && absPath !== "") {
      const abs = resolve(absPath);
      if (abs === base || abs.startsWith(base + sep)) return abs;
      // Ops from before rel_path existed carry only the origin's absolute path; re-root at its knowledge/ segment.
      const normalized = absPath.replace(/\\/g, "/");
      const idx = normalized.indexOf("/knowledge/");
      if (idx !== -1) return assertPathInside(base, normalized.slice(idx + 1));
    }
  } catch (err) {
    throw new UnappliableOpError(`unsafe path in remote op: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new UnappliableOpError("remote op path is outside the data directory");
}
