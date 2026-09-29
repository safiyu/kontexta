import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getDatabase } from "../db/index.js";

export function emitterVersionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

const DEV_HEADER = "// kontexta-hooks v0.0.0-dev";

// Bundlers rewrite import.meta.url, so besides the tsc/tsup/source layouts also look for the copy shipped inside node_modules/kxta-core on the way up.
export function emitterSourceCandidates(here: string, cwd: string): string[] {
  const out = [
    join(here, "emit.mjs"),
    join(here, "hooks", "emit.mjs"),
    join(here, "..", "..", "src", "hooks", "emit.mjs"),
    join(cwd, "packages", "core", "src", "hooks", "emit.mjs"),
    join(cwd, "packages", "core", "dist", "hooks", "emit.mjs"),
  ];
  let dir = here;
  for (let i = 0; i < 16; i++) {
    out.push(join(dir, "node_modules", "kxta-core", "dist", "hooks", "emit.mjs"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function emitterSourcePath(): string {
  const candidates = emitterSourceCandidates(dirname(fileURLToPath(import.meta.url)), process.cwd());
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`emit.mjs not found; looked in: ${candidates.join(", ")}`);
  return found;
}

// Content-derived so any emit.mjs change re-stages on the next reconcile; rulesVersion only moves when the rules block changes.
export const EMITTER_VERSION: string = (() => {
  try { return emitterVersionOf(readFileSync(emitterSourcePath(), "utf8")); } catch { return "unknown"; }
})();

export function stagedEmitterPath(dataDir: string): string {
  return join(dataDir, "hooks", "emit.mjs");
}

export function stageEmitter(dataDir: string): { path: string; changed: boolean; version: string } {
  const src = readFileSync(emitterSourcePath(), "utf8");
  const stamped = src.startsWith(DEV_HEADER) ? `// kontexta-hooks v${EMITTER_VERSION}${src.slice(DEV_HEADER.length)}` : src;
  const dst = stagedEmitterPath(dataDir);
  const current = existsSync(dst) ? readFileSync(dst, "utf8") : null;
  if (current === stamped) return { path: dst, changed: false, version: EMITTER_VERSION };
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  writeFileSync(tmp, stamped, "utf8");
  renameSync(tmp, dst);
  return { path: dst, changed: true, version: EMITTER_VERSION };
}

export function emitterVersionOnDisk(dataDir: string): string | null {
  try {
    const first = readFileSync(stagedEmitterPath(dataDir), "utf8").split("\n")[0];
    const m = first.match(/^\/\/ kontexta-hooks v(\S+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Reads the DB directly (not metadata.listProjects) so metadata can call this without an import cycle.
export function syncProjectsSidecar(dataDir: string): { path: string; count: number } {
  const rows = getDatabase()
    .prepare(`SELECT slug, path FROM projects WHERE path IS NOT NULL AND path != '' ORDER BY slug`)
    .all() as Array<{ slug: string; path: string }>;
  const projects = rows.map((p) => ({ slug: p.slug, path: p.path }));
  const path = join(dataDir, "hooks", "projects.json");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2), "utf8");
  renameSync(tmp, path);
  return { path, count: projects.length };
}

// Called from project registration; skipped under test and until hooks are staged so registering a project never creates files in a real data dir.
export function syncProjectsSidecarIfStaged(dataDir: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (!existsSync(join(dataDir, "hooks"))) return;
  syncProjectsSidecar(dataDir);
}

export function pruneHookState(dataDir: string, maxAgeDays = 30): number {
  const dir = join(dataDir, "hooks", "state");
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; } } catch {}
  }
  return removed;
}
