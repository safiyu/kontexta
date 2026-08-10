import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import open from 'open';
import { resolveDataDir } from './util/data-dir.js';
import { pickPort } from './util/port.js';

function resolveServerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, '..', 'bundle', 'standalone', 'apps', 'web', 'server.js');
  if (existsSync(bundled)) return bundled;
  const dev = resolve(here, '..', '..', '..', 'apps', 'web', '.next', 'standalone', 'apps', 'web', 'server.js');
  if (existsSync(dev)) return dev;
  throw new Error(
    'Web bundle not found. In dev, run `pnpm build` at the repo root. If installed via npm, the bundle should be under packages/cli/bundle/standalone/.',
  );
}

async function waitHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    await delay(500);
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms`);
}

export async function runStart(): Promise<never> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 22) {
    process.stderr.write(`kontexta requires Node 22.x LTS (found v${process.versions.node}). See .nvmrc.\n`);
    process.exit(1);
  }

  const data = resolveDataDir();
  process.stdout.write(`Using data at ${data.path}\n`);

  const rawPort = process.env.PORT;
  const preferred = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : 3000;
  if (rawPort && !/^\d+$/.test(rawPort)) {
    process.stderr.write(`PORT=${rawPort} is not a valid integer; using 3000\n`);
  }
  const port = await pickPort(preferred);
  if (port !== preferred) {
    process.stdout.write(`Port ${preferred} busy — using ${port}\n`);
  }

  const server = resolveServerEntry();
  const child: ChildProcess = spawn(process.execPath, [server], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PORT: String(port),
      KONTEXTA_DATA_DIR: data.path,
      HOSTNAME: '127.0.0.1',
    },
  });

  // Track actual process exit — `child.killed` flips true as soon as a signal
  // is *sent*, so gating a SIGKILL escalation on it means the kill never fires.
  let exited = false;
  const forward = (sig: NodeJS.Signals) => {
    child.kill(sig);
    setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000).unref();
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGTERM'));
  child.on('exit', (code) => { exited = true; process.exit(code ?? 0); });

  try {
    await waitHealth(port);
  } catch (e: any) {
    process.stderr.write(`${e.message}\n`);
    child.kill('SIGKILL');
    process.exit(1);
  }

  // Match the address we bind (HOSTNAME=127.0.0.1) — printing/opening
  // localhost is confusing when localhost resolves to ::1 first on IPv6 hosts.
  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(`Kontexta is ready at ${url}\n`);
  if (!process.env.KONTEXTA_NO_OPEN) {
    try { await open(url); } catch { /* headless env — URL already printed */ }
  }

  return new Promise<never>(() => {});
}
