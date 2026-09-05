import { createRequire } from 'node:module';

const HELP = `kontexta — one-click local dashboard + MCP server

Usage:
  kontexta start                     Boot dashboard + MCP on port 3000 (or $PORT)
  kontexta mcp                       Run stdio MCP server (for AI client config)
  kontexta doctor                    Print environment diagnostics
  kontexta doctor install-chromium   Download the Chromium build used for PDF export
  kontexta --version                 Print version
  kontexta --help                    Print this help
`;

(async () => {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (arg === '--version' || arg === '-v') {
    const require = createRequire(import.meta.url);
    const { version } = require('../package.json');
    process.stdout.write(`kontexta ${version}\n`);
    process.exit(0);
  }
  if (arg === 'mcp') {
    const { runMcp } = await import('./mcp.js');
    await runMcp();
    process.exit(0);
  }
  if (arg === 'doctor') {
    if (process.argv[3] === 'install-chromium') {
      const { installChromium } = await import('./doctor.js');
      process.exit(await installChromium());
    }
    const { runDoctor } = await import('./doctor.js');
    process.exit(await runDoctor());
  }
  if (arg === 'start') {
    const { runStart } = await import('./start.js');
    await runStart();
    process.exit(0);
  }
  process.stderr.write(`Unknown command: ${arg}\n`);
  process.stderr.write(HELP);
  process.exit(1);
})();
