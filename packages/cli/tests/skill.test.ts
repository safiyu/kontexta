import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

function runSkill(args: string, env: NodeJS.ProcessEnv) {
  return execSync(`node dist/index.js skill ${args}`, {
    cwd: pkgRoot,
    encoding: 'utf8',
    env,
  });
}

describe('kontexta skill install', () => {
  it('installs the skill into HOME/.claude/skills and makes kxta.py executable', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'kxta-skill-home-'));
    try {
      const out = runSkill('install', { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome });
      expect(out).toMatch(/Installed kontexta skill/);
      const dest = join(fakeHome, '.claude', 'skills', 'kontexta');
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(join(dest, 'scripts', 'kxta.py'))).toBe(true);
      // Sanity-check the payload is the real skill, not an empty shell.
      const kxta = readFileSync(join(dest, 'scripts', 'kxta.py'), 'utf8');
      expect(kxta).toMatch(/^#!.*python/);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing install without --force', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'kxta-skill-home-'));
    try {
      runSkill('install', { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome });
      let threw = false;
      try {
        execSync('node dist/index.js skill install', {
          cwd: pkgRoot,
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
          stdio: 'pipe',
        });
      } catch (e: any) {
        threw = true;
        expect(e.stderr.toString()).toMatch(/already installed/);
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--project installs into cwd/.claude/skills', () => {
    const fakeCwd = mkdtempSync(join(tmpdir(), 'kxta-skill-proj-'));
    try {
      execSync('node ' + join(pkgRoot, 'dist/index.js') + ' skill install --project', {
        cwd: fakeCwd,
        encoding: 'utf8',
        env: process.env,
      });
      expect(existsSync(join(fakeCwd, '.claude', 'skills', 'kontexta', 'scripts', 'kxta.py'))).toBe(true);
    } finally {
      rmSync(fakeCwd, { recursive: true, force: true });
    }
  });

  it('rejects unknown flags instead of silently installing user-wide', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'kxta-skill-home-'));
    try {
      let threw = false;
      try {
        execSync('node dist/index.js skill install --projet', {
          cwd: pkgRoot,
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
          stdio: 'pipe',
        });
      } catch (e: any) {
        threw = true;
        expect(e.stderr.toString()).toMatch(/Unknown option: --projet/);
      }
      expect(threw).toBe(true);
      expect(existsSync(join(fakeHome, '.claude'))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--force replaces an existing install and leaves no staging dir behind', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'kxta-skill-home-'));
    try {
      const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
      runSkill('install', env);
      const marker = join(fakeHome, '.claude', 'skills', 'kontexta', 'stale.txt');
      writeFileSync(marker, 'old');
      const out = runSkill('install --force', env);
      expect(out).toMatch(/new Claude Code session/);
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(join(fakeHome, '.claude', 'skills'))).toEqual(['kontexta']);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
