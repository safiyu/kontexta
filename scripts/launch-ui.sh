#!/usr/bin/env bash
# Launch the web UI.
# Usage:
#   scripts/launch-ui.sh           # production: next start (requires a prior build)
#   scripts/launch-ui.sh --dev     # development: next dev (hot reload)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "KONTEXTA env vars in this shell:" >&2
env | grep KONTEXTA >&2 || echo "  (none set)" >&2

mode="prod"
if [ "${1:-}" = "--dev" ] || [ "${1:-}" = "-d" ]; then
  mode="dev"
fi

if [ "$mode" = "dev" ]; then
  exec pnpm -F kxta-web dev
else
  # Test for a real build artifact, not just the .next directory — a
  # half-failed prior build leaves the dir present but missing BUILD_ID,
  # which makes `next start` fail with a confusing error instead of
  # triggering a clean rebuild.
  if [ ! -f apps/web/.next/BUILD_ID ]; then
    echo "No usable build output at apps/web/.next (missing BUILD_ID) - building..." >&2
    pnpm -F kxta-web build
  fi
  exec pnpm -F kxta-web start
fi
