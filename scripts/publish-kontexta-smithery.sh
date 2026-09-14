#!/usr/bin/env bash
# Publish Kontexta MCP to Smithery as an MCPB stdio bundle (no public HTTPS needed).
# Usage: ./scripts/publish-kontexta-smithery.sh [version] [namespace] [--dry-run]
# Defaults: version from package.json or npm (kontexta-mcp latest), namespace safiyu.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  if [ -f "${ROOT_DIR}/package.json" ]; then
    VERSION="$(node -p "require('${ROOT_DIR}/package.json').version" 2>/dev/null || true)"
  fi
fi
if [ -z "$VERSION" ]; then
  VERSION="$(npm view kontexta-mcp version)"
fi
echo "==> Publishing ${QUALIFIED} v${VERSION} to Smithery"

BUNDLE_NAME="kontexta-${VERSION}.mcpb"
BUNDLE_PATH="${ROOT_DIR}/${BUNDLE_NAME}"

# Smithery CLI
if ! command -v smithery >/dev/null 2>&1; then
  echo "==> Installing @smithery/cli"
  npm install -g @smithery/cli
fi

# Build the full Smithery bundle using the builder script
echo "==> Building full Smithery bundle"
node "${ROOT_DIR}/scripts/build-smithery-bundle.mjs" "${VERSION}" "${BUNDLE_PATH}"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> DRY RUN: bundle built at ${BUNDLE_PATH}"
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
