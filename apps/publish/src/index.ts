#!/usr/bin/env node
import { main } from "./cli.js";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Read version dynamically from package.json so it never drifts from the
// package manifest. Walks up from the compiled file's directory to find the
// nearest package.json belonging to kxta-publish.
function readVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (dir !== dirname(dir)) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg.name === "kxta-publish" && pkg.version) return pkg.version;
      }
      dir = dirname(dir);
    }
  } catch { /* fall through */ }
  return "0.0.0";
}

export const VERSION = readVersion();


function isMainEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(import.meta.url);
  if (argv1 === here) return true;
  try {
    return realpathSync(argv1) === here;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
