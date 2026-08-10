import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

// Build is handled once for the whole suite by tests/global-setup.ts.

describe('cli build', () => {
  it('produces dist/index.js', () => {
    expect(existsSync(__dirname + '/../dist/index.js')).toBe(true);
  });

  it('dist/index.js runs and prints usage', () => {
    const out = execSync('node dist/index.js --help', {
      cwd: __dirname + '/..',
      encoding: 'utf8',
    });
    expect(out).toMatch(/kontexta/i);
    expect(out).toMatch(/start/);
  });
});

describe('cli bundle', () => {
  const bundleRoot = __dirname + '/../bundle';
  const standalone = bundleRoot + '/standalone';

  beforeAll(() => {
    rmSync(bundleRoot, { recursive: true, force: true });
    execSync('pnpm run pack:bundle', { cwd: __dirname + '/..', stdio: 'inherit' });
  });

  it('populates bundle/ with the web standalone tree', () => {
    expect(existsSync(standalone + '/apps/web/server.js')).toBe(true);
    expect(existsSync(standalone + '/apps/web/.next/static')).toBe(true);
    expect(existsSync(standalone + '/apps/web/public')).toBe(true);
  });

  it('bundles private workspace packages as real directories under node_modules/', () => {
    // kxta-core
    expect(existsSync(standalone + '/node_modules/kxta-core/dist')).toBe(true);
    expect(existsSync(standalone + '/node_modules/kxta-core/package.json')).toBe(true);

    // kxta-publish
    expect(existsSync(standalone + '/node_modules/kxta-publish/dist')).toBe(true);
    expect(existsSync(standalone + '/node_modules/kxta-publish/package.json')).toBe(true);

    // kontexta-mcp
    expect(existsSync(standalone + '/node_modules/kontexta-mcp/dist')).toBe(true);
    expect(existsSync(standalone + '/node_modules/kontexta-mcp/dist/index.js')).toBe(true);
    expect(existsSync(standalone + '/node_modules/kontexta-mcp/package.json')).toBe(true);
  });

  it('excludes pnpm node_modules from the bundle', () => {
    expect(existsSync(standalone + '/node_modules/.pnpm')).toBe(false);
    expect(existsSync(standalone + '/apps/web/node_modules')).toBe(false);
  });

  it('contains no native binaries (.node files)', () => {
    const nativeFiles: string[] = [];

    function walkDir(dir: string) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.node')) {
          nativeFiles.push(fullPath);
        }
      }
    }

    walkDir(standalone);
    expect(nativeFiles).toEqual([]);
  });

  it('contains no symlinks', () => {
    const symlinks: string[] = [];

    function walkDir(dir: string) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) {
          symlinks.push(fullPath);
        } else if (entry.isDirectory()) {
          walkDir(fullPath);
        }
      }
    }

    walkDir(standalone);
    expect(symlinks).toEqual([]);
  });

  it('has no workspace:* specifiers in bundled package.json files', () => {
    const pkgsWithWorkspace: string[] = [];

    for (const pkg of ['kxta-core', 'kxta-publish', 'kontexta-mcp']) {
      const pkgPath = standalone + `/node_modules/${pkg}/package.json`;
      const raw = readFileSync(pkgPath, 'utf8');
      if (raw.includes('workspace:')) {
        pkgsWithWorkspace.push(pkg);
      }
    }

    expect(pkgsWithWorkspace).toEqual([]);
  });
});
