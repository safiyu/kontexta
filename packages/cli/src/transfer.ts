import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpEntry } from './mcp.js';

/**
 * `kontexta export|import ...`: back up / move contexts. Like `brain`, the command body ships inside the MCP
 * bundle (apps/mcp/dist/transfer-cli.js); this is a thin spawner that execs it with inherited stdio.
 */
export function resolveTransferEntry(): string {
  const entry = join(dirname(resolveMcpEntry()), 'transfer-cli.js');
  if (!existsSync(entry)) throw new Error(`transfer-cli.js not found next to the MCP entry (${entry}). Rebuild apps/mcp.`);
  return entry;
}

export async function runTransfer(cmd: 'export' | 'import', argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = spawnSync(process.execPath, [resolveTransferEntry(), cmd, ...argv], {
    stdio: 'inherit',
    env: { KONTEXTA_VIA_CLI: '1', ...env },
  });
  return r.status ?? 1;
}
