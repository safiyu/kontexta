#!/usr/bin/env node
import { main } from "./cli.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export const VERSION = "3.0.1";

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
