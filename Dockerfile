# Stage 1: Build
FROM node:24-slim AS builder
WORKDIR /app

# Install pnpm and native build tools (required for oniguruma, better-sqlite3, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gcc \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

# Copy workspace configuration and lockfile
# We copy the lockfile to ensure reproducible builds
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/publish/package.json ./apps/publish/
COPY packages/core/package.json ./packages/core/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Rebuild native bindings (better-sqlite3, re2) for this exact Node version.
# pnpm's content-addressable store may contain binaries built for a different
# Node ABI; `pnpm rebuild` discovers the install paths from the lockfile, so
# this stays correct across version bumps (vs `cd .pnpm/foo@X.Y.Z/...` which
# silently breaks the moment X.Y.Z changes).
RUN pnpm rebuild better-sqlite3 re2

# Copy the rest of the source code
COPY . .

# Skip manifest generation during Docker builds — gen:manifest spawns the MCP
# binary which calls listProjects() → SQLite at startup, but no DB exists at
# build time. The manifest is only used by the web UI to list available tools.
ENV KONTEXTA_SKIP_MANIFEST=1

# Build everything
RUN pnpm build

# Deploy MCP server with its production dependencies
# This creates a standalone directory with its own node_modules.
# --legacy: pnpm v10 now requires inject-workspace-packages by default;
# this flag restores the pre-v10 copy behaviour for deployment bundles.
RUN pnpm --filter kontexta-mcp deploy --legacy /app/mcp-deploy

# Stage 2: Runner
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV KONTEXTA_DATA_DIR=/app/data
ENV KONTEXTA_DB_PATH=/app/data/kontexta.db
ENV HOSTNAME=0.0.0.0

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Fix "dubious ownership" errors for mounted volumes
RUN git config --global --add safe.directory '*'

# Create data directory and switch to non-root user for the runtime.
# The `node` user ships with the official image (uid/gid 1000); chown ensures
# the data dir is writable for it.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Copy built standalone web app
COPY --from=builder /app/apps/web/next.config.ts ./
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Explicitly copy migration SQL files and agent-rules to a predictable path
# that resolveMigrationsDir() can always find, regardless of how Next.js
# file-tracing resolves __dirname at runtime.
COPY --from=builder /app/packages/core/src/db/migrations ./packages/core/src/db/migrations
COPY --from=builder /app/packages/core/src/agent-rules/rules-block.md ./packages/core/src/agent-rules/rules-block.md

# Copy deployed MCP server
COPY --from=builder /app/mcp-deploy ./apps/mcp

# Web UI on 3000. The file-watcher WebSocket shares this same port
# (upgrade path /_kontexta_ws), so no separate port is exposed.
EXPOSE 3000

# Drop privileges. Anything bind-mounted in must be readable by uid 1000.
USER node

# We use the built standalone server
CMD ["node", "apps/web/server.js"]
