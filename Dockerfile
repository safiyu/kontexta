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

# Rebuild better-sqlite3 native binding for this exact Node version.
# pnpm's content-addressable store may contain a binary built for a different
# Node ABI; running node-gyp directly in the package dir bypasses that cache.
RUN cd node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3 \
    && npx node-gyp rebuild -j max

# Rebuild re2 native binding for this exact Node version.
RUN cd node_modules/.pnpm/re2@1.24.1/node_modules/re2 \
    && npx node-gyp rebuild -j max

# Copy the rest of the source code
COPY . .

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

# Create data directory with proper permissions
RUN mkdir -p /app/data

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

# We use the built standalone server
CMD ["node", "apps/web/server.js"]
