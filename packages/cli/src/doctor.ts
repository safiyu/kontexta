import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveDataDir } from './util/data-dir.js';

const require = createRequire(import.meta.url);

type CheckResult = { name: string; ok: boolean; detail: string };

function checkNode(): CheckResult {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  const ok = major >= 22;
  return { name: 'Node', ok, detail: `v${v}${ok ? '' : ' (required: >= 22)'}` };
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

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e);
      try {
        const s = statSync(p);
        if (s.isDirectory()) stack.push(p);
        else total += s.size;
      } catch {}
    }
  }
  return total;
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function checkPuppeteerChromium(): CheckResult {
  try {
    const cache = process.env.KONTEXTA_CHROMIUM_CACHE ?? join(homedir() || tmpdir(), '.cache', 'kontexta', 'chromium');
    if (!existsSync(cache)) {
      return { name: 'puppeteer-chromium', ok: false, detail: 'not installed (run `kontexta doctor install-chromium` or wait for first PDF export)' };
    }
    const entries = readdirSync(cache);
    const buildDirs = entries.filter((e) => e.startsWith('chrome') || e.startsWith('chromium'));
    if (buildDirs.length === 0) {
      return { name: 'puppeteer-chromium', ok: false, detail: 'not installed (run `kontexta doctor install-chromium` or wait for first PDF export)' };
    }
    const size = humanSize(dirSizeBytes(cache));
    return { name: 'puppeteer-chromium', ok: true, detail: `${buildDirs.join(', ')} (${size}) in ${cache}` };
  } catch (e: any) {
    return { name: 'puppeteer-chromium', ok: false, detail: `check failed: ${e?.message ?? e}` };
  }
}

export async function installChromium(): Promise<number> {
  try {
    const b: any = await import('@puppeteer/browsers');
    const cache = process.env.KONTEXTA_CHROMIUM_CACHE ?? join(homedir() || tmpdir(), '.cache', 'kontexta', 'chromium');
    const platform = b.detectBrowserPlatform() ?? b.BrowserPlatform.LINUX;
    const buildId = await b.resolveBuildId(b.Browser.CHROMIUM, platform, 'latest');
    const exec = b.computeExecutablePath({ browser: b.Browser.CHROMIUM, buildId, cacheDir: cache });
    if (existsSync(exec)) { process.stdout.write(`Already present: ${exec}\n`); return 0; }
    process.stdout.write(`Downloading Chromium ${buildId} to ${cache}…\n`);
    await b.install({ browser: b.Browser.CHROMIUM, buildId, cacheDir: cache });
    process.stdout.write(`Installed: ${exec}\n`);
    return 0;
  } catch (e: any) {
    process.stderr.write(`install-chromium failed: ${e?.message ?? e}\n`);
    return 1;
  }
}

export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [
    checkNode(),
    checkDataDir(),
    checkNative('better-sqlite3'),
    checkNative('re2'),
    checkPuppeteerChromium(),
  ];
  for (const r of results) {
    process.stdout.write(`${r.name}: ${r.detail}\n`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
