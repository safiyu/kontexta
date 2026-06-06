#!/usr/bin/env sh
# Low-memory dev server for memory-constrained hosts (Cloud Workstations, small VMs).
# - Reaps any orphaned `next-server` left behind by a previous Ctrl-C'd dev run
#   (the pnpm/turbo parent dies on Ctrl-C but the grandchild server often lingers,
#   holding port 3000 and forcing the next start onto 3001).
# - Runs `next dev` on webpack (no Turbopack) with a capped heap so Node fails
#   fast instead of pushing the host into OOM.
#
# NOTE: this lives in a file (not inline in package.json) on purpose — an inline
# `pkill -f next-server` would match the script's own runner shell (whose command
# line contains the pattern) and kill it before next dev starts.
#
# Unix-only (uses pkill). Use `pnpm dev` (Turbopack, cross-platform) when you have
# memory headroom.

# Reap stray servers; ignore "no process matched" (exit 1).
pkill -f next-server 2>/dev/null || true

exec env NODE_OPTIONS=--max-old-space-size=1536 next dev
