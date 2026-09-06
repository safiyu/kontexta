# kontexta

> One-click local dashboard + MCP server for AI coding agents

The Kontexta CLI brings the full dashboard and MCP server to your machine with a single `npx` command—no Docker, no build, no setup.

## Quick Start

```bash
npx kontexta start
```

Boots the dashboard on `http://localhost:23002` (opens in your browser) and starts the MCP server. First run walks you through master password, data location, and project registration.

## Subcommands

- **`kontexta start`** — boot dashboard + MCP server on port 23002 (or `$PORT`)
- **`kontexta mcp`** — run stdio MCP server (for AI client config)
- **`kontexta doctor`** — print environment diagnostics

### MCP-only (no dashboard)

If you only want the MCP server (no dashboard), point your AI client at:

```json
{
  "mcpServers": {
    "kxta": {
      "command": "npx",
      "args": ["-y", "kontexta", "mcp"]
    }
  }
}
```

## Requirements

- **Node.js 22.x LTS** — the CLI detects your Node version and warns if it's incompatible
- Nothing else — the CLI bundles all dependencies and prebuilt native modules

## What it bundles

The `kontexta` package includes:

- The full Next.js dashboard (standalone server)
- The MCP server (stdio, for use with AI agents)
- Prebuilt native modules (`better-sqlite3`, `re2`) for Linux, macOS, and Windows
- All runtime dependencies, bundled into a single ~28 MB tarball

No Docker, no pnpm, no build step.

## More information

Full documentation: [github.com/safiyu/kontexta](https://github.com/safiyu/kontexta)

## License

Apache-2.0
