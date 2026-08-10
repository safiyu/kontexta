#!/usr/bin/env node
/*
 * Builds packages/cli/bundle/ from apps/web/.next/{standalone,static} and
 * apps/web/public/.
 *
 * Critical: skip every `node_modules` directory in the standalone tree. In a
 * pnpm workspace the standalone output's node_modules are symlinks into
 * `<repo>/node_modules/.pnpm/…`. `cpSync` preserves them as absolute symlinks,
 * and `npm pack` silently strips symlinks from the tarball — the published
 * package would look intact but fail with `Cannot find module 'next'` on boot.
 *
 * Instead we ship:
 *   1. The standalone tree WITHOUT any node_modules segments.
 *   2. Real copies of private workspace deps (kxta-core, kxta-publish) inside
 *      bundle/standalone/node_modules/ so Node's walk-up resolves them.
 *   3. Everything else (next, react, jsdom, better-sqlite3, …) as CLI
 *      dependencies in package.json — npm installs them at install time under
 *      the CLI's own node_modules, where the standalone server can walk up to
 *      find them.
 */

import { cpSync, existsSync, rmSync, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '..', '..');
const webNext = resolve(repoRoot, 'apps', 'web', '.next');
const bundle = resolve(cliRoot, 'bundle');
const bundleStandalone = resolve(bundle, 'standalone');
const bundleNodeModules = resolve(bundleStandalone, 'node_modules');

/** Skip any path containing a `node_modules` segment. */
const skipNodeModules = (src) => {
  const parts = src.split(sep);
  return !parts.includes('node_modules');
};

const sources = [
  {
    from: resolve(webNext, 'standalone'),
    to: bundleStandalone,
    filter: skipNodeModules,
  },
  {
    from: resolve(webNext, 'static'),
    to: resolve(bundleStandalone, 'apps', 'web', '.next', 'static'),
  },
  {
    from: resolve(repoRoot, 'apps', 'web', 'public'),
    to: resolve(bundleStandalone, 'apps', 'web', 'public'),
  },
];

for (const s of sources) {
  if (!existsSync(s.from)) {
    console.error(`pack-bundle: missing ${s.from}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

rmSync(bundle, { recursive: true, force: true });
mkdirSync(bundle, { recursive: true });

for (const s of sources) {
  cpSync(s.from, s.to, { recursive: true, filter: s.filter });
  console.log(`  copied  ${s.from} -> ${s.to}`);
}

// Index every workspace package.json by name for workspace:* rewrites.
function loadWorkspaceIndex() {
  const idx = new Map();
  for (const base of ['packages', 'apps']) {
    const baseDir = resolve(repoRoot, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir)) {
      const dir = resolve(baseDir, entry);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const p = resolve(dir, 'package.json');
      if (!existsSync(p)) continue;
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        if (pkg?.name) idx.set(pkg.name, { path: p, pkg, dir });
      } catch { /* ignore malformed */ }
    }
  }
  return idx;
}
const workspaceIndex = loadWorkspaceIndex();

/**
 * Copy a private workspace package into bundle/standalone/node_modules/<name>/.
 * Ships dist/ + a rewritten package.json (workspace:* -> real versions,
 * devDependencies/scripts stripped).
 */
function bundlePrivateWorkspacePkg(name) {
  const entry = workspaceIndex.get(name);
  if (!entry) throw new Error(`pack-bundle: workspace package ${name} not found`);
  const { pkg, dir: srcDir } = entry;

  const destDir = resolve(bundleNodeModules, name);
  mkdirSync(destDir, { recursive: true });

  const distSrc = resolve(srcDir, 'dist');
  if (!existsSync(distSrc)) {
    console.error(`pack-bundle: ${name} has no dist/ — run \`pnpm -C ${srcDir} build\` first.`);
    process.exit(1);
  }
  cpSync(distSrc, resolve(destDir, 'dist'), { recursive: true, filter: skipNodeModules });

  const rewrite = (deps) => {
    if (!deps) return deps;
    const out = {};
    for (const [k, v] of Object.entries(deps)) {
      if (typeof v === 'string' && v.startsWith('workspace:')) {
        const target = workspaceIndex.get(k);
        if (!target) throw new Error(`pack-bundle: cannot resolve workspace dep ${k} from ${name}`);
        out[k] = target.pkg.version;
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const stripped = { ...pkg };
  if (stripped.dependencies) stripped.dependencies = rewrite(stripped.dependencies);
  if (stripped.peerDependencies) stripped.peerDependencies = rewrite(stripped.peerDependencies);
  delete stripped.devDependencies;
  delete stripped.scripts;

  writeFileSync(
    resolve(destDir, 'package.json'),
    JSON.stringify(stripped, null, 2) + '\n',
  );
  console.log(`  bundled ${name} -> ${destDir}`);
}

// Private workspace packages the standalone server (and `kontexta mcp`) need
// at runtime. kontexta-mcp is bundled — not npm-installed — because the
// currently-published kontexta-mcp@4.2.0 has a stray `kxta-core: workspace:*`
// dep in its registry manifest, which crashes npm/Arborist with EUNSUPPORTEDPROTOCOL.
// Shipping our own copy sidesteps that until the mcp manifest is fixed.
bundlePrivateWorkspacePkg('kxta-core');
bundlePrivateWorkspacePkg('kxta-publish');
bundlePrivateWorkspacePkg('kontexta-mcp');

// Delete the redundant workspace source copies that Next standalone laid down.
// The symlinks that used to point at them are gone; every runtime import now
// resolves through bundle/standalone/node_modules/. Keeping these dirs around
// bloats the tarball and, worse, leaves package.json files with unresolvable
// `workspace:*` (rewritten below) or with names that clash with node_modules.
for (const junk of ['apps/mcp', 'apps/publish', 'packages']) {
  rmSync(resolve(bundleStandalone, junk), { recursive: true, force: true });
}

// Rewrite any lingering `workspace:*` deps in package.json files copied out of
// the monorepo (Next standalone puts workspace pkg.jsons at their monorepo
// paths). Node's resolver ignores these fields, but `npm install` reads every
// package.json under node_modules and Arborist crashes on workspace: URLs.
function walkPkgJsons(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = resolve(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === 'package.json') out.push(p);
    }
  }
  return out;
}
for (const p of walkPkgJsons(bundleStandalone)) {
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { continue; }
  if (!raw.includes('workspace:')) continue;
  let pkg;
  try { pkg = JSON.parse(raw); } catch { continue; }
  let changed = false;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[field]) continue;
    for (const [k, v] of Object.entries(pkg[field])) {
      if (typeof v === 'string' && v.startsWith('workspace:')) {
        const target = workspaceIndex.get(k);
        if (target) pkg[field][k] = target.pkg.version;
        else delete pkg[field][k];
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('Bundle ready.');
