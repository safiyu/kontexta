import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const cliRoot = __dirname + '/..';
const repoRoot = join(cliRoot, '..', '..');
// The real command body ships inside apps/mcp (next to the MCP entry), like
// hooks-cli/connect-cli. packages/cli/src/endpoint.ts is a thin spawner that
// execs this file. We test the body directly so the suite is deterministic and
// independent of the gitignored dev bundle (packages/cli/bundle) being fresh.
const entry = join(repoRoot, 'apps', 'mcp', 'dist', 'endpoint-cli.js');

async function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [entry, ...args], {
      cwd: cliRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

/**
 * A minimal in-process kontexta-storage-server (spec 1.6) just rich enough to
 * exercise the CLI: health, self-registration (one-time token), and empty op
 * polling. Real op application is covered by the kxta-core client/apply tests.
 */
let server: http.Server;
let base: string;
let lastIssuedToken = '';

beforeAll(async () => {
  // Ensure the body is built (produced by apps/mcp's `tsc`). A full workspace
  // `pnpm build` already produces it; this keeps the suite self-sufficient when
  // packages/cli is tested in isolation.
  if (!existsSync(entry)) {
    execSync('pnpm -C apps/mcp build', { cwd: repoRoot, stdio: 'inherit' });
  }
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, service: 'kontexta-storage-server' }));
      }
      if (u.pathname === '/clients' && req.method === 'POST') {
        lastIssuedToken = randomBytes(16).toString('hex');
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ machine_id: 'testmachine1', registered: true, token: lastIssuedToken }));
      }
      if (u.pathname === '/ops' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ops: [], next: Number(u.searchParams.get('since') ?? 0) }));
      }
      if (u.pathname === '/ops' && req.method === 'POST') {
        const arr = (JSON.parse(body || '[]') as unknown[]).length ? JSON.parse(body) : [];
        let seq = 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            machine_id: 'testmachine1',
            results: arr.map((o: { client_seq?: number }) => ({ client_seq: o.client_seq, seq: seq++, status: 'ok' })),
          }),
        );
      }
      res.writeHead(404);
      return res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('kontexta endpoint (command body)', () => {
  function freshEnv(): { env: Record<string, string>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'kx-endpoint-data-'));
    return { env: { KONTEXTA_DATA_DIR: dir }, dir };
  }

  it('help lists the endpoint command', () => {
    const r = execSync('node dist/index.js --help', { cwd: cliRoot, encoding: 'utf8' });
    expect(r).toMatch(/kontexta endpoint <connect\|status\|disconnect\|push\|pull\|run>/);
  });

  it('rejects an unknown subcommand with usage (exit 2)', async () => {
    const { env, dir } = freshEnv();
    try {
      const r = await cli(['bogus'], env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/Usage:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects `connect` with no URL (exit 2)', async () => {
    const { env, dir } = freshEnv();
    try {
      const r = await cli(['connect'], env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/connect:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status reports not connected before any connect', async () => {
    const { env, dir } = freshEnv();
    try {
      const r = await cli(['status'], env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/not connected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connect self-registers (POST /clients), verifies, and persists the token', async () => {
    const { env, dir } = freshEnv();
    try {
      const r = await cli(['connect', base], env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(new RegExp(`connected to ${escapeRegExp(base)}`));
      expect(r.out).toMatch(/registered/);
      // Token is masked as first4…last4, never printed in the clear.
      const mask = `${lastIssuedToken.slice(0, 4)}…${lastIssuedToken.slice(-4)}`;
      expect(r.out).toContain(mask);
      expect(r.out).not.toContain(lastIssuedToken);

      const s = await cli(['status', '--json'], env);
      expect(s.code, s.err).toBe(0);
      const report = JSON.parse(s.out);
      expect(report.connected).toBe(true);
      expect(report.url).toBe(base);
      expect(report.token).toBe(mask);
      expect(report.activePollIntervalMs).toBe(15000);
      expect(report.idlePollIntervalMs).toBe(60000);
      expect(report.syncCursor).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connect accepts an explicit token (no self-registration)', async () => {
    const { env, dir } = freshEnv();
    try {
      const r = await cli(['connect', base, 'my-explicit-token-1234567890'], env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/provided/);
      const s = await cli(['status', '--json'], env);
      expect(JSON.parse(s.out).token).toBe('my-e…7890');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('push with an empty outbox reports nothing to push', async () => {
    const { env, dir } = freshEnv();
    try {
      await cli(['connect', base], env);
      const r = await cli(['push'], env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/outbox empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pull with no remote ops advances the cursor and reports applied 0', async () => {
    const { env, dir } = freshEnv();
    try {
      await cli(['connect', base], env);
      const r = await cli(['pull'], env);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/pulled 0 op\(s\), applied 0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('push/pull before connect report "not connected" (exit 1)', async () => {
    const { env, dir } = freshEnv();
    try {
      const p = await cli(['push'], env);
      expect(p.code).toBe(1);
      expect(p.out).toMatch(/not connected/);
      const l = await cli(['pull'], env);
      expect(l.code).toBe(1);
      expect(l.out).toMatch(/not connected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disconnect clears credentials; status reflects the change', async () => {
    const { env, dir } = freshEnv();
    try {
      await cli(['connect', base], env);
      const d = await cli(['disconnect'], env);
      expect(d.code, d.err).toBe(0);
      expect(d.out).toMatch(/disconnected/);
      const s = await cli(['status', '--json'], env);
      expect(JSON.parse(s.out).connected).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-http(s) URL at connect time', async () => {
    const { env, dir } = freshEnv();
    try {
      const r = await cli(['connect', 'ftp://not-a-valid-scheme.example', 'tok'], env);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/protocol|valid URL/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
