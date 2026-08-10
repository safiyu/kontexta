import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

describe('kontexta start', () => {
  it('boots the server, health returns 200, shuts down on SIGTERM', async () => {
    const port = 45400;
    const child = spawn('node', ['dist/index.js', 'start'], {
      cwd: __dirname + '/..',
      env: { ...process.env, PORT: String(port), KONTEXTA_DATA_DIR: '/tmp/kontexta-start-test', KONTEXTA_NO_OPEN: '1' },
    });

    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) { ready = true; break; }
      } catch { /* not up yet */ }
      await delay(500);
    }

    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));

    expect(ready).toBe(true);
  }, 60_000);
});
