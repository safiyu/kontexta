import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { pickPort } from '../../src/util/port.js';

function occupy(port: number): Promise<() => void> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(port, '127.0.0.1', () => resolve(() => s.close()));
  });
}

describe('pickPort', () => {
  it('returns preferred port when free', async () => {
    const p = await pickPort(45123, 3);
    expect(p).toBe(45123);
  });

  it('picks next free port when preferred is busy', async () => {
    const release = await occupy(45200);
    try {
      const p = await pickPort(45200, 3);
      expect(p).toBe(45201);
    } finally {
      release();
    }
  });

  it('throws when range exhausted', async () => {
    const r1 = await occupy(45300);
    const r2 = await occupy(45301);
    const r3 = await occupy(45302);
    try {
      await expect(pickPort(45300, 3)).rejects.toThrow(/No free port/);
    } finally {
      r1(); r2(); r3();
    }
  });
});
