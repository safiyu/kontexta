import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = __dirname + '/..';

function cli(args: string[], env: Record<string, string>) {
  const r = spawnSync('node', ['dist/index.js', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('kontexta hooks', () => {
  it('status/enable/disable round-trip against a temp HOME and data dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'kx-cli-home-'));
    const data = mkdtempSync(join(tmpdir(), 'kx-cli-data-'));
    const env = { HOME: home, KONTEXTA_DATA_DIR: data };
    try {
      let r = cli(['hooks', 'status', '--json'], env);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toHaveLength(15);
      r = cli(['hooks', 'enable', 'cursor', '--home', home], env);
      expect(r.code, r.err).toBe(0);
      expect(existsSync(join(home, '.cursor', 'hooks.json'))).toBe(true);
      r = cli(['hooks', 'disable', 'cursor'], env);
      expect(r.code).toBe(0);
      r = cli(['hooks'], env);
      expect(r.code).toBe(2);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
  });

  it('help lists the hooks command', () => {
    const r = cli(['--help'], {});
    expect(r.out).toMatch(/kontexta hooks/);
  });

  it('doctor reports hooks staging', () => {
    const data = mkdtempSync(join(tmpdir(), 'kx-cli-data-'));
    try {
      const r = cli(['doctor'], { KONTEXTA_DATA_DIR: data });
      expect(r.out).toMatch(/^hooks: /m);
    } finally { rmSync(data, { recursive: true, force: true }); }
  });
});
