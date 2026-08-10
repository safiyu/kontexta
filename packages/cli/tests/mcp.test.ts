import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

describe('kontexta mcp', () => {
  it('responds to initialize handshake', async () => {
    const child = spawn('node', ['dist/index.js', 'mcp'], { cwd: __dirname + '/..' });
    const initReq = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    child.stdin.write(initReq + '\n');

    const response = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
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
  }, 20_000);
});
