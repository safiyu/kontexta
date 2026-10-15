import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpEntry } from './mcp.js';

/**
 * `kontexta endpoint …` — manage this machine's storage-server connection
 * (connect / status / disconnect / push / pull).
 *
 * Like `hooks` and `connect`, the command body ships inside the MCP bundle
 * (apps/mcp/dist/endpoint-cli.js) so it reaches kxta-core without a second
 * dependency graph. This package stays a thin spawner: it locates the bundled
 * entry next to the MCP server entry and execs it, inheriting stdio so the
 * user sees progress directly. The `KONTEXTA_VIA_CLI` marker tells the entry
 * it was launched through the `kontexta` wrapper (vs. a bare `kxta` binary).
 */
export function resolveEndpointEntry(): string {
  const entry = join(dirname(resolveMcpEntry()), 'endpoint-cli.js');
  if (!existsSync(entry)) throw new Error(`endpoint-cli.js not found next to the MCP entry (${entry}). Rebuild apps/mcp.`);
  return entry;
}

export async function runEndpoint(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = spawnSync(process.execPath, [resolveEndpointEntry(), ...argv], {
    stdio: 'inherit',
    env: { KONTEXTA_VIA_CLI: '1', ...env },
  });
  return r.status ?? 1;
}
