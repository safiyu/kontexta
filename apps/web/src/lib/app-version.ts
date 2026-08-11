import { readFileSync } from "node:fs";
import path from "node:path";

let cachedVersion: string | null = null;

// Shared by install-snippets and version-check so both read the running version the same way.
export function currentVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    cachedVersion = String(pkg.version ?? "0.0.0");
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
