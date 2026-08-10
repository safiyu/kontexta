import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest globalSetup: build dist/ once before any test runs. Several tests
 * (`doctor`, `mcp`, `start`) spawn `node dist/index.js …` and would otherwise
 * silently exec whatever stale build happens to be sitting around — or nothing.
 */
export default function setup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, '..');
  execSync('pnpm run build', { cwd: pkgRoot, stdio: 'inherit' });
}
