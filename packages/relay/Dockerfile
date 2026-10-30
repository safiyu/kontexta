# kontexta-relay — one server hosting many fully separate brains.
#
# Spec 1.6: a plain, stateless short-polling HTTP service designed for
# serverless hosting (Cloud Run et al.). No persistent connections, one SQLite
# file under /data, a single published port (23010).
#
# Isolated build: this package has ZERO workspace dependencies (hono,
# @hono/node-server, better-sqlite3 — all from the npm registry), so it is
# built standalone instead of via the workspace (which would drag the whole
# graph — re2, onnxruntime, @huggingface — into this image).
#
# Why npm, not pnpm: pnpm 10 gates dependency build scripts behind an
# approval list (onlyBuiltDependencies) read from the WORKSPACE root's
# pnpm-workspace.yaml. This build is isolated — there is no workspace root —
# so better-sqlite3's native-binary build script is silently skipped and the
# install fails with ERR_PNPM_IGNORED_BUILDS. npm runs postinstall scripts by
# default, so `npm install` here builds (or prebuild-fetches) better-sqlite3
# without any approval dance. The package has no workspace deps, so npm's
# flat node_modules is exactly what we want.
#
# Nested layout: the package tsconfig.json extends `../../tsconfig.json`
# (the repo root). We preserve that two-level layout in the builder —
# /app/tsconfig.json + /app/packages/relay/* — so the extends target
# resolves. (Copying both tsconfigs to the same flat path would break it.)

# Stage 1: Build
FROM node:24-slim AS builder
WORKDIR /app

# Package manifest + the tsconfig it extends (repo root, two levels up) +
# the package's own tsconfig + sources. Kept under packages/relay to
# mirror the repo so `extends: ../../tsconfig.json` resolves.
COPY tsconfig.json ./tsconfig.json
COPY packages/relay/package.json ./packages/relay/package.json
COPY packages/relay/tsconfig.json ./packages/relay/tsconfig.json
COPY packages/relay/src ./packages/relay/src

WORKDIR /app/packages/relay

# Install this package's dependencies in isolation (no workspace context),
# build, then drop devDependencies (typescript, vitest, @types) so the runner
# image only ships the three production deps. tsc needs the dev deps only for
# this build step, which completes before the prune.
RUN npm install --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev

# Stage 2: Runner
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=23010 \
    HOSTNAME=0.0.0.0 \
    KXTA_RELAY_DB=/data/kontexta-relay.db

# Copy the built server + its (production) dependencies + the sources. The
# db/schema.sql is a .sql file (not emitted by tsc) resolved from src/db at
# runtime — see src/db/index.ts (it searches /app/src/db, the layout we copy
# here).
COPY --from=builder /app/packages/relay/node_modules ./node_modules
COPY --from=builder /app/packages/relay/package.json ./package.json
COPY --from=builder /app/packages/relay/dist ./dist
COPY --from=builder /app/packages/relay/src ./src

# The SQLite op log + clients table live on this volume. Create it before
# dropping privileges so the node user (uid 1000) can write to it; bind- and
# named-volume mounts are owned by the container user on first use.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

# Short-poll traffic is the only traffic; Cloud Run probes /health.
EXPOSE 23010

USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||23010)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
