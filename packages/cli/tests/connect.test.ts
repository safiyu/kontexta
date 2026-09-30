import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = __dirname + '/..';

function cli(args: string[], env: Record<string, string>) {
  const r = spawnSync('node', ['dist/index.js', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('kontexta connect', () => {
  it('registers the local CLI server (`kontexta mcp`) because the wrapper proves it is installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'kx-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'kx-cli-data-'));
    mkdirSync(join(home, '.cursor'));
    const env = { HOME: home, KONTEXTA_DATA_DIR: data };
    try {
      let r = cli(['connect', 'install', '--agent', 'cursor', '--home', home], env);
      expect(r.code, r.err).toBe(0);
      const args = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.kxta.args;
      expect(args).toEqual(['-y', 'kontexta', 'mcp']);
      r = cli(['connect', 'status', '--json', '--home', home], env);
      expect(JSON.parse(r.out).find((x: { id: string }) => x.id === 'cursor')).toMatchObject({ installed: true });
      expect(cli(['connect'], env).code).toBe(2);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
  });

  it('help lists the connect command', () => {
    expect(cli(['--help'], {}).out).toMatch(/kontexta connect/);
  });
});
