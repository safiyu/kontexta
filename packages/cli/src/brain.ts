import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpEntry } from './mcp.js';

/**
 * `kontexta brain ...`: connect this machine to a brain on a remote and manage that connection.
 *
 * Like `hooks` and `connect`, the command body ships inside the MCP bundle (apps/mcp/dist/brain-cli.js) so it
 * reaches kxta-core without a second dependency graph. This package stays a thin spawner: it locates the bundled
 * entry next to the MCP server entry and execs it, inheriting stdio. The `KONTEXTA_VIA_CLI` marker tells the entry
 * it was launched through the `kontexta` wrapper.
 */
export function resolveBrainEntry(): string {
  const entry = join(dirname(resolveMcpEntry()), 'brain-cli.js');
  if (!existsSync(entry)) throw new Error(`brain-cli.js not found next to the MCP entry (${entry}). Rebuild apps/mcp.`);
  return entry;
}

export async function runBrain(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = spawnSync(process.execPath, [resolveBrainEntry(), ...argv], {
    stdio: 'inherit',
    env: { KONTEXTA_VIA_CLI: '1', ...env },
  });
  return r.status ?? 1;
}
