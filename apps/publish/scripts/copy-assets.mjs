#!/usr/bin/env node
// Cross-platform replacement for `mkdir -p dist/template dist/seeds && cp
// src/template/*.css src/template/app.js dist/template/ && cp
// src/seeds/*.md dist/seeds/`. Used by `pnpm build`. Avoids Windows
// failures (no `mkdir -p`/`cp` in cmd.exe) that would otherwise produce a
// build with missing template/seed assets.

import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

function copyMatching(srcDir, dstDir, predicate) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (predicate(name)) {
      copyFileSync(join(srcDir, name), join(dstDir, name));
    }
  }
}

copyMatching(
  join(pkgRoot, "src", "template"),
  join(pkgRoot, "dist", "template"),
  (name) => extname(name) === ".css" || name === "app.js",
);

copyMatching(
  join(pkgRoot, "src", "seeds"),
  join(pkgRoot, "dist", "seeds"),
  (name) => extname(name) === ".md",
);
