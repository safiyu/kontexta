import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpEntry } from './mcp.js';

const DOWNLOAD_TIMEOUT_MS = 180_000;

export function runModelsEnsure(env: NodeJS.ProcessEnv = process.env): number {
  const entry = join(dirname(resolveMcpEntry()), 'models-cli.js');
  if (!existsSync(entry)) throw new Error(`models-cli.js not found next to the MCP entry (${entry}). Rebuild apps/mcp.`);
  const r = spawnSync(process.execPath, [entry, 'ensure'], { stdio: 'inherit', env, timeout: DOWNLOAD_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    process.stderr.write(`reranker model download exceeded ${DOWNLOAD_TIMEOUT_MS / 1000}s; continuing without it (search falls back to BM25 order)\n`);
    return 1;
  }
  return r.status ?? 1;
}
