import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function acquireCooldown(baseDir: string, projectSlug: string, cooldownSeconds: number): boolean {
  mkdirSync(join(baseDir, projectSlug), { recursive: true });
  const lockPath = join(baseDir, projectSlug, ".distill.lock");
  if (existsSync(lockPath)) {
    try {
      const ts = Number(readFileSync(lockPath, "utf8"));
      if (!isNaN(ts) && Date.now() - ts < cooldownSeconds * 1000) return false;
      // stale; fall through and overwrite
    } catch { /* ignore corrupted lock */ }
  }
  writeFileSync(lockPath, String(Date.now()));
  return true;
}

export function releaseCooldown(baseDir: string, projectSlug: string): void {
  const lockPath = join(baseDir, projectSlug, ".distill.lock");
  if (existsSync(lockPath)) {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
