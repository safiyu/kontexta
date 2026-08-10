#!/usr/bin/env bash
set -euo pipefail

# Assumes CI already has Node 22 available via nvm/actions.

./bootstrap

# Idempotency
./bootstrap

# Verify pnpm was activated and install completed
command -v pnpm >/dev/null
test -d node_modules
test -f packages/core/dist/index.js

echo "bootstrap smoke: OK"
