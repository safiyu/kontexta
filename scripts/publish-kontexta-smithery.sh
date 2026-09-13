#!/usr/bin/env bash
ROOT_DIR=$(pwd)
# Publish Kontexta MCP to Smithery as an MCPB stdio bundle (no public HTTPS needed).
# Usage: ./scripts/publish-kontexta-smithery.sh [version] [namespace] [--dry-run]
# Defaults: version from package.json or npm (kontexta-mcp latest), namespace safiyu.
set -euo pipefail

VERSION=""
NAMESPACE="safiyu"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *) if [ -z "$VERSION" ]; then VERSION="$arg"; else NAMESPACE="$arg"; fi ;;
  esac
done
QUALIFIED="${NAMESPACE}/kontexta"

# Version: arg > package.json > npm latest
if [ -z "$VERSION" ]; then
  if [ -f "package.json" ]; then
    VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  fi
fi
if [ -z "$VERSION" ]; then
  VERSION="$(npm view kontexta-mcp version)"
fi
echo "==> Publishing ${QUALIFIED} v${VERSION} to Smithery"

WORK="$(mktemp -d)"
# The smithery CLI is a Node app: hand it a native Windows path, not MSYS /tmp/...
WORK_NATIVE="$(cygpath -w "$WORK" 2>/dev/null || echo "$WORK")"
trap 'rm -rf "$WORK"' EXIT
BUNDLE_NAME="kontexta-${VERSION}.mcpb"

# Packer (Anthropic MCPB CLI)
if ! command -v mcpb >/dev/null 2>&1; then
  echo "==> Installing @anthropic-ai/mcpb"
  npm install -g @anthropic-ai/mcpb
fi

# Smithery CLI
if ! command -v smithery >/dev/null 2>&1; then
  echo "==> Installing @smithery/cli"
  npm install -g @smithery/cli
fi

# Build the full Smithery bundle using the new builder script
echo "==> Building full Smithery bundle"
node "${ROOT_DIR}/scripts/build-smithery-bundle.mjs" "${VERSION}" "${ROOT_DIR}/kontexta-${VERSION}.mcpb"
BUNDLE_PATH="${ROOT_DIR}/kontexta-${VERSION}.mcpb"
  "manifest_version": "0.3",
  "name": "kontexta",
  "version": "${VERSION}",
  "description": "Local-first MCP server: persistent knowledge vault, governed sandbox, and journal loop for AI coding agents",
  "author": { "name": "safiyu" },
  "server": {
    "type": "node",
    "entry_point": "launcher.js",
    "mcp_config": {
      "command": "npx",
      "args": ["-y", "kontexta-mcp"]
    }
  },
  "user_config": {
    "KONTEXTA_DATA_DIR": {
      "type": "string",
      "title": "Vault directory",
      "description": "Absolute path where kontexta stores its vault (defaults to your OS data directory if left empty)",
      "required": false
    }
  }
}
EOF

# Entry point must exist even though hosts use mcp_config directly
cat > "${WORK}/launcher.js" <<'EOF'
const { spawn } = require("node:child_process");
const child = spawn("npx", ["-y", "kontexta-mcp"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
EOF

# Keep the bundle a tiny wrapper (no package.json -> no node_modules)
printf 'package.json\n' > "${WORK}/.mcpbignore"

# Bundle is already packed by build-smithery-bundle.mjs

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> DRY RUN: bundle built at ${WORK}/${BUNDLE_NAME} (not deleting; trap disabled)"
  trap - EXIT
  exit 0
fi

# In CI, ensure SMITHERY_API_KEY is present
if [ -n "${CI:-}" ] && [ -z "${SMITHERY_API_KEY:-}" ]; then
  echo "::error::SMITHERY_API_KEY environment variable is missing." >&2
  exit 1
fi

# Requires `smithery` CLI + prior login or SMITHERY_API_KEY
smithery mcp publish "${BUNDLE_PATH}" -n "${QUALIFIED}"
echo "==> Done: https://smithery.ai/servers/${QUALIFIED}"
