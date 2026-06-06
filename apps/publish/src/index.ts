#!/usr/bin/env node
import { main } from "./cli.js";
import { fileURLToPath } from "node:url";

export const VERSION = "2.0.10";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
