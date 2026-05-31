#!/bin/sh
# Launch the web UI.
# Usage:
#   scripts/launch-ui.sh           # production: next start (requires a prior build)
#   scripts/launch-ui.sh --dev     # development: next dev (hot reload)
set -eu

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
  if [ ! -d apps/web/.next ]; then
    echo "No build output found at apps/web/.next - running build first..." >&2
    pnpm -F kxta-web build
  fi
  exec pnpm -F kxta-web start
fi
