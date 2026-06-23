#!/usr/bin/env bash
# Build every package + app in the workspace via Turborepo.
# Usage:  scripts/build-all.sh
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm -r build
