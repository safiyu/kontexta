import { existsSync, mkdirSync, cpSync, chmodSync, rmSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HELP = `kontexta skill — install the kontexta agent-skill bridge (no-MCP fallback)

Usage:
  kontexta skill install [--project] [--force]

Options:
  --project   Install into .claude/skills in the current directory so it is
              committed with the code. Default is user-wide under ~/.claude/skills.
  --force     Overwrite an existing install.
`;

const INSTALL_FLAGS = new Set(['--project', '--force']);

export function resolveSkillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Installed layout: <global>/node_modules/kontexta/{dist,skills}/…
  const bundled = resolve(here, '..', 'skills', 'kontexta');
  if (existsSync(bundled)) return bundled;
  // Dev layout: monorepo root at <repo>/skills/kontexta.
  const dev = resolve(here, '..', '..', '..', 'skills', 'kontexta');
  if (existsSync(dev)) return dev;
  throw new Error(
    'kontexta skill files not found. In dev, run `node packages/cli/scripts/pack-bundle.mjs` first, or install from a published build.',
  );
}

export async function runSkill(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  if (sub !== 'install') {
    process.stderr.write(`Unknown skill subcommand: ${sub}\n${HELP}`);
    return 1;
  }

  const flags = argv.slice(1);
  const unknown = flags.filter((f) => !INSTALL_FLAGS.has(f));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n${HELP}`);
    return 1;
  }
  const project = flags.includes('--project');
  const force = flags.includes('--force');

  const src = resolveSkillSource();
  const baseDir = project
    ? resolve(process.cwd(), '.claude', 'skills')
    : resolve(homedir(), '.claude', 'skills');
  const dest = join(baseDir, 'kontexta');

  if (existsSync(dest) && !force) {
    process.stderr.write(
      `Skill already installed at ${dest}. Re-run with --force to overwrite.\n`,
    );
    return 1;
  }

  // Copy beside the target first so a failed copy never costs the existing install.
  mkdirSync(baseDir, { recursive: true });
  const staging = join(baseDir, `.kontexta.tmp-${process.pid}`);
  try {
    cpSync(src, staging, { recursive: true, filter: (p) => !/(^|[\\/])__pycache__([\\/]|$)/.test(p) });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const script = join(dest, 'scripts', 'kxta.py');
  if (existsSync(script)) {
    try { chmodSync(script, 0o755); } catch { /* ignore on Windows / read-only FS */ }
  }

  const py = process.platform === 'win32' ? 'python' : 'python3';
  process.stdout.write(`Installed kontexta skill → ${dest}\n`);
  process.stdout.write('Start a new Claude Code session so the skill is picked up.\n');
  process.stdout.write(`Smoke test:\n  ${py} ${script} call projects_list '{}'\n`);
  process.stdout.write(`Teach the agent the bridge (run in your project root):\n  ${py} ${script} rules --write\n`);
  return 0;
}
