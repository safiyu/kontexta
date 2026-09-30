#!/bin/sh
# Dispatch: `mcp` → stdio MCP server, `hooks …` → hooks CLI, `connect …` → MCP installer CLI, no args → dashboard, anything else → exec as given (compose `command:` overrides).
set -e
case "${1:-}" in
  mcp)   shift; exec node apps/mcp/dist/index.js "$@" ;;
  hooks) shift; exec node apps/mcp/dist/hooks-cli.js "$@" ;;
  connect) shift; exec node apps/mcp/dist/connect-cli.js "$@" ;;
  "")    exec node apps/web/server.js ;;
  *)     exec "$@" ;;
esac
