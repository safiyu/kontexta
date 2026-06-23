#!/usr/bin/env node
// Cross-platform replacement for `cp -r src/db/migrations dist/db/ && cp
// src/agent-rules/rules-block.md ...`. Used by `pnpm build`. Avoids Windows
// failures (no `cp`/`mkdir -p`) that would otherwise produce a build with
// missing runtime assets — and which getRulesBlockBody() then surfaces only
// when something actually tries to inject rules.

import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (st.isFile()) {
      copyFileSync(s, d);
    }
  }
}

const moves = [
  { from: join(pkgRoot, "src", "db", "migrations"), to: join(pkgRoot, "dist", "db", "migrations"), kind: "dir" },
  { from: join(pkgRoot, "src", "agent-rules", "rules-block.md"), to: join(pkgRoot, "dist", "agent-rules", "rules-block.md"), kind: "file" },
];

for (const m of moves) {
  if (m.kind === "dir") {
    copyDirRecursive(m.from, m.to);
  } else {
    mkdirSync(dirname(m.to), { recursive: true });
    copyFileSync(m.from, m.to);
  }
}
