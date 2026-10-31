#!/usr/bin/env node
// `kontexta export|import`: move existing contexts (KB + project files, with tags/favorites) between machines.
// Ships inside the MCP bundle so it reaches kxta-core without a second dependency graph (like brain-cli).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ensureDataDir,
  resetDataDirCache,
  getDataDir,
  getDatabase,
  closeDatabase,
  exportContexts,
  writeArchive,
  readArchive,
  importContexts,
  type ContentClass,
} from "kxta-core";

const USAGE = `kontexta export / import: back up or move your contexts

Usage:
  kontexta export <file> [--project <slug> | --kb-only] [--kind <dictionary|note|journal|project>]
                         [--tag <name>]... [--json]
      Write contexts (files, tags, favorites, project metadata) to <file>.
      A .gz suffix (e.g. contexts.kxta.json.gz) compresses the archive.
  kontexta import <file> [--dry-run] [--json]
      Load an archive. Files that already exist at the same path are OVERWRITTEN.

Common flags: --data-dir <dir>
`;

function print(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

export async function runTransferCli(cmd: "export" | "import", argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "kb-only": { type: "boolean", default: false },
      project: { type: "string" },
      kind: { type: "string" },
      tag: { type: "string", multiple: true },
      "data-dir": { type: "string" },
    },
  });
  const file = positionals[0];
  if (!file) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.kind && !["dictionary", "note", "journal", "project"].includes(values.kind)) {
    process.stderr.write("--kind must be one of dictionary, note, journal, project\n");
    return 2;
  }
  if (values.project && values["kb-only"]) {
    process.stderr.write("--project and --kb-only are mutually exclusive\n");
    return 2;
  }
  if (values["data-dir"]) {
    process.env.KONTEXTA_DATA_DIR = values["data-dir"];
    resetDataDirCache();
  }
  ensureDataDir();
  getDatabase();
  const dataDir = getDataDir();
  try {
    if (cmd === "export") {
      const archive = exportContexts({
        dataDir,
        project: values.project,
        kbOnly: values["kb-only"],
        contentClass: values.kind as ContentClass | undefined,
        tags: values.tag,
      });
      writeArchive(archive, file);
      const summary = { file, files: archive.files.length, projects: archive.projects.length };
      print(values.json ? JSON.stringify(summary) : `exported ${summary.files} file(s), ${summary.projects} project(s) → ${file}`);
      return 0;
    }
    const archive = readArchive(file);
    const r = await importContexts(archive, { dataDir, dryRun: values["dry-run"] });
    if (values.json) {
      print(JSON.stringify(r));
    } else {
      print(
        `${r.dry_run ? "[dry run] would import" : "imported"}: ${r.created} created, ${r.overwritten} overwritten, ` +
          `${r.projects_created} project(s) created, ${r.errors.length} error(s)`,
      );
      for (const e of r.errors) process.stderr.write(`  error: ${e.path}: ${e.error}\n`);
    }
    return r.errors.length > 0 ? 1 : 0;
  } finally {
    closeDatabase();
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "export" && cmd !== "import") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    runTransferCli(cmd, rest).then(
      (code) => {
        process.exitCode = code;
      },
      (e) => {
        process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
        process.exitCode = 1;
      },
    );
  }
}
