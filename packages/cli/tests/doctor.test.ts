import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('kontexta doctor', () => {
  it('prints diagnostics and exits 0 on healthy env', () => {
    const out = execSync('node dist/index.js doctor', { cwd: __dirname + '/..', encoding: 'utf8' });
    expect(out).toMatch(/Node: v\d+\./);
    expect(out).toMatch(/Data dir:/);
    expect(out).toMatch(/better-sqlite3: OK/);
    expect(out).toMatch(/re2: OK/);
  });

  it('still exits 0 when Chromium has never been downloaded (fresh install / clean CI runner)', () => {
    const emptyCache = mkdtempSync(join(tmpdir(), 'kxta-doctor-nochromium-'));
    try {
      const out = execSync('node dist/index.js doctor', {
        cwd: __dirname + '/..',
        encoding: 'utf8',
        env: { ...process.env, KONTEXTA_CHROMIUM_CACHE: emptyCache },
      });
      expect(out).toMatch(/puppeteer-chromium: not installed/);
    } finally {
      rmSync(emptyCache, { recursive: true, force: true });
    }
  });
});
