import { createServer } from 'node:net';

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

export async function pickPort(preferred: number, maxTries = 20): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const p = preferred + i;
    if (await isFree(p)) return p;
  }
  throw new Error(`No free port in range ${preferred}..${preferred + maxTries - 1}`);
}
