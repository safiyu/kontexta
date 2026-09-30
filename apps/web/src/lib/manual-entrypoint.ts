import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Written by ./bootstrap / bootstrap.ps1 at repo root: the source of truth for a manual install's entrypoint.
const MANUAL_INSTALL_FLAG = ".kontexta-manual-mcp";
const MAX_LEVELS = 15;

function* ancestors(start: string): Generator<string> {
  let dir = start;
  for (let i = 0; i < MAX_LEVELS; i++) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function fromMarker(start: string): string | null {
  for (const dir of ancestors(start)) {
    const flagPath = path.join(dir, MANUAL_INSTALL_FLAG);
    if (!existsSync(flagPath)) continue;
    const raw = readFileSync(flagPath, "utf-8").trim();
    if (!raw) return null;
    // Resolve relative entrypoints against the flag's own dir, then require containment, since an attacker dropping a flag file elsewhere can only point to executables inside that same tree, not e.g. /tmp/evil-binary.
    const resolved = path.resolve(dir, raw);
    const flagDirReal = path.resolve(dir) + path.sep;
    if (!(resolved === path.resolve(dir) || resolved.startsWith(flagDirReal))) return null;
    return existsSync(resolved) ? resolved : null;
  }
  return null;
}

// A checkout that was built but never bootstrapped (e.g. `pnpm dev`) still has apps/mcp/dist/index.js next to the web app.
function fromCheckout(start: string): string | null {
  for (const dir of ancestors(start)) {
    const built = path.join(dir, "apps", "mcp", "dist", "index.js");
    if (existsSync(built)) return built;
  }
  return null;
}

// Only cache a real resolved path: caching null latched the "no manual install" state for the process lifetime even after the user ran bootstrap.
const cache: { marker: string | null; any: string | null } = { marker: null, any: null };
const moduleDir = () => path.dirname(fileURLToPath(import.meta.url));

// The bootstrap marker only (the INSTALL tab snippet keeps telling people to run ./bootstrap without it).
export function resolveMarkerEntrypoint(startDir?: string): string | null {
  if (!startDir && cache.marker) return cache.marker;
  // Walk up from this module's own file, not process.cwd(), which Next's standalone server.js chdir()s away from repo root.
  const found = fromMarker(startDir ?? moduleDir());
  if (found && !startDir) cache.marker = found;
  return found;
}

// The marker, else a built checkout: what the installer needs to register a source install.
export function resolveManualEntrypoint(startDir?: string): string | null {
  if (!startDir && cache.any) return cache.any;
  const found = fromMarker(startDir ?? moduleDir()) ?? fromCheckout(startDir ?? moduleDir());
  if (found && !startDir) cache.any = found;
  return found;
}
