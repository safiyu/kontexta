import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpEntry } from './mcp.js';

export function resolveHooksEntry(): string {
  const entry = join(dirname(resolveMcpEntry()), 'hooks-cli.js');
  if (!existsSync(entry)) throw new Error(`hooks-cli.js not found next to the MCP entry (${entry}). Rebuild apps/mcp.`);
  return entry;
}

export async function runHooks(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = spawnSync(process.execPath, [resolveHooksEntry(), ...argv], { stdio: 'inherit', env });
  return r.status ?? 1;
}
