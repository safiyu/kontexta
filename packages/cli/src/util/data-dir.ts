import os from 'os';
import path from 'path';

export type DataDirResolution = { path: string; source: 'env' | 'default' };

function defaultDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "kontexta");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "kontexta"
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        "kontexta"
      );
  }
}

export function resolveDataDir(): DataDirResolution {
  const raw = process.env.KONTEXTA_DATA_DIR?.trim();
  if (raw) return { path: raw, source: 'env' };
  return { path: defaultDataDir(), source: 'default' };
}
