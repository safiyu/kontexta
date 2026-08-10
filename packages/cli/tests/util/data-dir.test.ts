import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { resolveDataDir } from '../../src/util/data-dir.js';

describe('resolveDataDir', () => {
  const originalEnv = process.env.KONTEXTA_DATA_DIR;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.KONTEXTA_DATA_DIR;
    else process.env.KONTEXTA_DATA_DIR = originalEnv;
  });

  it('returns env-set path when KONTEXTA_DATA_DIR is set', () => {
    process.env.KONTEXTA_DATA_DIR = '/tmp/custom-vault';
    const r = resolveDataDir();
    expect(r.path).toBe('/tmp/custom-vault');
    expect(r.source).toBe('env');
  });

  it('returns OS default when env is unset', () => {
    delete process.env.KONTEXTA_DATA_DIR;
    const r = resolveDataDir();
    expect(r.path).toContain('kontexta');
    expect(r.source).toBe('default');
  });

  it('trims and rejects empty env value', () => {
    process.env.KONTEXTA_DATA_DIR = '   ';
    const r = resolveDataDir();
    expect(r.source).toBe('default');
  });

  it('returns platform-specific default path', () => {
    delete process.env.KONTEXTA_DATA_DIR;
    const r = resolveDataDir();
    const home = os.homedir();
    let expected: string;
    switch (process.platform) {
      case "darwin":
        expected = path.join(home, "Library", "Application Support", "kontexta");
        break;
      case "win32":
        expected = path.join(
          process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
          "kontexta"
        );
        break;
      default:
        expected = path.join(
          process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
          "kontexta"
        );
    }
    expect(r.path).toBe(expected);
  });
});
