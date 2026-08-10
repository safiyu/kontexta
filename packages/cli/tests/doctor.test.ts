import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('kontexta doctor', () => {
  it('prints diagnostics and exits 0 on healthy env', () => {
    const out = execSync('node dist/index.js doctor', { cwd: __dirname + '/..', encoding: 'utf8' });
    expect(out).toMatch(/Node: v22\./);
    expect(out).toMatch(/Data dir:/);
    expect(out).toMatch(/better-sqlite3: OK/);
    expect(out).toMatch(/re2: OK/);
  });
});
