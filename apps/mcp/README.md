# kontexta-mcp

[![npm](https://img.shields.io/npm/v/kontexta-mcp.svg)](https://www.npmjs.com/package/kontexta-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

MCP server for [Kontexta](https://github.com/safiyu/kontexta) — 46 tools that let agents search, read, edit (section-level), tag, version, and clip web content into a local SQLite-backed knowledge base. Designed for context-window economy: every file-returning response is annotated with `est_tokens` and `size_bytes`.

## Install

The server is launched on demand by your AI client; no global install needed.

```json
{
  "mcpServers": {
    "kontexta": {
      "command": "npx",
      "args": ["-y", "kontexta-mcp"],
      "env": {
        "KONTEXTA_DATA_DIR": "/absolute/path/to/your/data"
      }
    }
  }
}
```

`KONTEXTA_DATA_DIR` **must** be an absolute path. The directory is created on first run and holds your SQLite DB plus the markdown files the agent indexes.

## Client config locations

| Client | Path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | Settings → Features → MCP |
| Continue | `~/.continue/config.json` |
| Codex | `.codex/mcp_servers.json` |
| Gemini / Antigravity | `~/.gemini/antigravity/mcp_servers.json` |

## Web UI (optional)

The MCP server runs headless. If you want the matching three-pane web UI, run the Docker image alongside it (it reads the same `KONTEXTA_DATA_DIR`):

```bash
docker run -d -p 3000:3000 -v /absolute/path/to/your/data:/app/data safiyu/kontexta:latest
```

Open `http://localhost:3000`.

## Requirements

- Node ≥ 20 (the package is published as ESM, target node20).
- `better-sqlite3` ships prebuilt binaries for linux/macos/windows on x64 and arm64. If your platform isn't covered (Alpine/musl, RISC-V, older Node), `npm install` falls back to a from-source build that needs `python3` and a C++ toolchain.

## Documentation

Full docs, the reference for 46 core + unlimited custom hand tools, and the web UI live in the [main repository](https://github.com/safiyu/kontexta). See [`CHANGELOG.md`](https://github.com/safiyu/kontexta/blob/main/CHANGELOG.md) for what's new.

## License

Apache-2.0
