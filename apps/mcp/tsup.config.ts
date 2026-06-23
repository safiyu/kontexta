import { defineConfig } from "tsup";
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  shims: false,
  noExternal: ["kxta-core"],
  // Native + runtime-resolved deps. tsup will leave these as plain imports
  // so npm install resolves prebuilt binaries / platform-specific modules.
  // undici is also external: it's a CJS module that uses dynamic require()
  // of Node built-ins (e.g. "assert"), which esbuild cannot bundle into ESM.
  // It's available at runtime on Node 18+ as the fetch implementation.
  external: [
    "better-sqlite3",
    "chokidar",
    "fsevents",
    "@modelcontextprotocol/sdk",
    "zod",
    "simple-git",
    "undici",
  ],
  // Migration .sql files live under packages/core/src/db/migrations/ in
  // the source tree but `runMigrations()` in the bundled output reads
  // them from join(__dirname, "migrations"). After bundling, __dirname
  // is apps/mcp/dist/, so files must land at dist/migrations/.
  onSuccess: async () => {
    const srcDir = resolve(__dirname, "../../packages/core/src/db/migrations");
    const dstDir = resolve(__dirname, "dist/migrations");
    mkdirSync(dstDir, { recursive: true });
    for (const f of readdirSync(srcDir)) {
      if (f.endsWith(".sql")) {
        copyFileSync(join(srcDir, f), join(dstDir, f));
      }
    }
    console.log(`[tsup] copied migrations from ${srcDir} → ${dstDir}`);

    // Rules block markdown. The bundled kxta-core loader looks for the
    // file at either join(__dirname, "rules-block.md") or
    // join(__dirname, "agent-rules", "rules-block.md") — we use the latter
    // so the path is unambiguous and disjoint from the bundle entry.
    const rulesSrc = resolve(__dirname, "../../packages/core/src/agent-rules/rules-block.md");
    const rulesDstDir = resolve(__dirname, "dist/agent-rules");
    mkdirSync(rulesDstDir, { recursive: true });
    copyFileSync(rulesSrc, join(rulesDstDir, "rules-block.md"));
    console.log(`[tsup] copied rules-block.md → ${rulesDstDir}/rules-block.md`);
  },
});
