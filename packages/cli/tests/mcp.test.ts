import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('kontexta mcp', () => {
  it('responds to initialize handshake', async () => {
    // Isolated data dir so MCP init doesn't fight the ambient vault on the runner and migrations run against a fresh SQLite file.
    const dataDir = mkdtempSync(join(tmpdir(), 'kxta-mcp-init-'));
    const child = spawn('node', ['dist/index.js', 'mcp'], {
      cwd: __dirname + '/..',
      env: { ...process.env, KONTEXTA_DATA_DIR: dataDir },
      shell: process.platform === 'win32',
    });

    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const initReq = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    child.stdin.write(initReq + '\n');

    const response = await new Promise<string>((resolve, reject) => {
      let buf = '';
      // 30s covers Windows-runner MCP boot cost (imports + 9 migrations + FTS index) — Linux typically responds in <2s.
      const timer = setTimeout(() => reject(new Error(`timeout after 30s; stderr=${stderr.slice(-500)}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
        }
      });
      child.on('error', reject);
    });

    child.kill('SIGTERM');
    const parsed = JSON.parse(response);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result?.capabilities).toBeDefined();
  }, 45_000);
});
