import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMcpEntry } from './mcp.js';

export function resolveConnectEntry(): string {
  const entry = join(dirname(resolveMcpEntry()), 'connect-cli.js');
  if (!existsSync(entry)) throw new Error(`connect-cli.js not found next to the MCP entry (${entry}). Rebuild apps/mcp.`);
  return entry;
}

// The `kontexta` wrapper is what makes `npx -y kontexta mcp` valid, so tell the installer it exists.
export async function runConnect(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const r = spawnSync(process.execPath, [resolveConnectEntry(), ...argv], { stdio: 'inherit', env: { KONTEXTA_INSTALL_HINT: 'npm', ...env, KONTEXTA_VIA_CLI: '1' } });
  return r.status ?? 1;
}
