import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = process.cwd();
const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = rootPkg.version;
const rulesVersion = rootPkg.rulesVersion;

const targets = [
  'apps/mcp/package.json',
  'apps/publish/package.json',
  'apps/web/package.json',
  'packages/core/package.json',
  'glama.json'
];

console.log(`Syncing version ${version} (rules: ${rulesVersion}) to all packages...`);

for (const target of targets) {
  const path = join(rootDir, target);
  const content = JSON.parse(readFileSync(path, 'utf8'));
  content.version = version;
  if (rulesVersion) {
    content.rulesVersion = rulesVersion;
  }
  writeFileSync(path, JSON.stringify(content, null, 2) + '\n');
  console.log(`  ✓ ${target}`);
}

console.log('Sync complete.');
