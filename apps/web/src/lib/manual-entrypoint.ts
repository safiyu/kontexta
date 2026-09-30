import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Written by ./bootstrap / bootstrap.ps1 at repo root: the source of truth for a manual install's entrypoint.
const MANUAL_INSTALL_FLAG = ".kontexta-manual-mcp";

// Only cache a real resolved path: caching null latched the "no manual install" state for the process lifetime even after the user ran bootstrap.
let cachedManualEntrypoint: string | null = null;
export function resolveManualEntrypoint(): string | null {
  if (cachedManualEntrypoint) return cachedManualEntrypoint;
  // Walk up from this module's own file: not process.cwd(), which Next's standalone server.js chdir()s away from repo root.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 15; i++) {
    const flagPath = path.join(dir, MANUAL_INSTALL_FLAG);
    if (existsSync(flagPath)) {
      const raw = readFileSync(flagPath, "utf-8").trim();
      if (!raw) return null;
      // Resolve relative entrypoints against the flag's own dir, then require containment: an attacker dropping a flag file elsewhere can only point to executables inside that same tree, not e.g. /tmp/evil-binary.
      const resolved = path.resolve(dir, raw);
      const flagDirReal = path.resolve(dir) + path.sep;
      if (!(resolved === path.resolve(dir) || resolved.startsWith(flagDirReal))) return null;
      if (!existsSync(resolved)) return null;
      cachedManualEntrypoint = resolved;
      return cachedManualEntrypoint;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
