import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function resolveMcpEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Installed layout: <global>/node_modules/kontexta/{dist,bundle}/…
  const bundled = resolve(
    here,
    '..',
    'bundle',
    'standalone',
    'node_modules',
    'kontexta-mcp',
    'dist',
    'index.js',
  );
  if (existsSync(bundled)) return bundled;
  // Dev layout: resolve via monorepo path.
  const dev = resolve(here, '..', '..', '..', 'apps', 'mcp', 'dist', 'index.js');
  if (existsSync(dev)) return dev;
  throw new Error(
    'kontexta-mcp entry not found. In dev, run `pnpm -C apps/mcp build` first.',
  );
}

export async function runMcp(): Promise<never> {
  const entry = resolveMcpEntry();
  await import(pathToFileURL(entry).href);
  return new Promise<never>(() => {});
}
