import { createRequire } from 'node:module';
import { resolveDataDir } from './util/data-dir.js';

const require = createRequire(import.meta.url);

type CheckResult = { name: string; ok: boolean; detail: string };

function checkNode(): CheckResult {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  const ok = major === 22;
  return { name: 'Node', ok, detail: `v${v}${ok ? '' : ' (required: 22.x)'}` };
}

function checkDataDir(): CheckResult {
  const r = resolveDataDir();
  return { name: 'Data dir', ok: true, detail: `${r.path} (source: ${r.source})` };
}

function checkNative(mod: string): CheckResult {
  try {
    require(mod);
    return { name: mod, ok: true, detail: 'OK' };
  } catch (e: any) {
    return {
      name: mod,
      ok: false,
      detail: `FAIL — ${e.message}. Try: npm rebuild ${mod}`,
    };
  }
}

export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [
    checkNode(),
    checkDataDir(),
    checkNative('better-sqlite3'),
    checkNative('re2'),
  ];
  for (const r of results) {
    process.stdout.write(`${r.name}: ${r.detail}\n`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
