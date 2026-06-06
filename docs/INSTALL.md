# Installing Kontexta

Kontexta ships three install paths:

- **[Docker Hub compose](#docker-hub-compose)** — full UI + MCP server, no build, recommended for most users
- **[Docker run](#docker-run)** — single `docker run` invocation, useful for ad-hoc spawning
- **[Build from source](#build-from-source)** — clone the repo and build the image locally
- **[Local development](#local-development)** — run from source without Docker

For MCP-only setups (no web UI), see [MCP install via npm](MCP.md#install-via-npm).

---

## Docker Hub compose

Requires Docker 24+ with the compose plugin.

Pull and run the pre-built image from [Docker Hub](https://hub.docker.com/r/safiyu/kontexta) in a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/safiyu/kontexta/main/docker-compose.hub.yml \
  | docker compose -f - up -d
```

Or download the compose file first and run it directly:

```bash
curl -fsSL https://raw.githubusercontent.com/safiyu/kontexta/main/docker-compose.hub.yml \
  -o docker-compose.hub.yml

docker compose -f docker-compose.hub.yml up -d
```

### Configuring the Compose file

Before running `docker compose up`, open `docker-compose.hub.yml` and check the following:

1. **Mount your projects**: For Kontexta to index your code, you **must** mount your host projects directory. Find the `volumes` section and uncomment/edit the projects line:
   ```yaml
   volumes:
     - ${DATA_DIR:-./kontexta-data}:/app/data   # data dir on the host
     # IMPORTANT: `PROJECT_DIR` must be an absolute host path and it is mounted
     # to the SAME absolute path inside the container so file paths are stable.
      - ${PROJECT_DIR}:${PROJECT_DIR}  # REQUIRED: must be an absolute host path and match inside the container
   ```
   > [!TIP]
    > Mounting the host path to the **exact same path** inside the container ensures that the AI client on your host and the MCP server in the container agree on file paths.

  **Required:** `PROJECT_DIR` must be set to an absolute path before running compose. The compose file includes a startup check that fails fast if `PROJECT_DIR` is not set.

2. **Data Persistence**: By default, your vault (SQLite, backups, KB) is stored in `./kontexta-data` relative to the compose file. Use `DATA_DIR` to change the host-side path (e.g., `DATA_DIR=/var/lib/kontexta`).

3. **Port Mapping**: If port `3000` is already in use on your host, set `HOST_PORT`:
   ```bash
   HOST_PORT=8080 docker compose -f docker-compose.hub.yml up -d
   ```
   The WebSocket file-watcher shares this same port (upgrade path `/_kontexta_ws`) — no second port to publish.

**Example (absolute paths):**
```bash
DATA_DIR=/var/lib/kontexta \
PROJECT_DIR=/home/safiyu/Projects \
HOST_PORT=8080 \
docker compose -f docker-compose.hub.yml up -d
```

4. **Version Pinning**: To pin a specific release instead of `latest`, change `image: safiyu/kontexta:latest` to a specific version (e.g., `safiyu/kontexta:7.0.0`).

To update to the newest image:

```bash
docker compose -f docker-compose.hub.yml pull
docker compose -f docker-compose.hub.yml up -d
```

---

## Docker run

The fastest way to run Kontexta in production is using the official Docker Hub image. This is the same image used by the [Glama Registry](https://glama.ai/mcp/servers/safiyu/kontexta).

```bash
docker run -d \
  -p 3000:3000 \
  # using environment variables to keep the host paths explicit
  -v "$DATA_DIR":/app/data \
  -v "$PROJECT_DIR":/projects \
  --name kontexta \
  safiyu/kontexta:latest
```

**Flag breakdown:**
- `-d`: Run in detached mode (background).
- `-p 3000:3000`: Publish the Web UI. The WebSocket file-watcher shares this port (upgrade path `/_kontexta_ws`), so no second `-p` is needed.
- `-v ...:/app/data`: Persist your vault (SQLite, backups, knowledge base).
- `-v /host/path:/container/path`: Mount your projects so the agent can see them.
- `--name kontexta`: Give the container a predictable name (useful for `docker exec` MCP tool calls).


---

## Build from source

Clone the repo and build the image locally (useful if you want to modify the source):

```bash
git clone <repository-url>
cd kontexta
docker compose up -d --build
```

---

## After install

Access the UI at `http://localhost:3000`. The WebSocket file-watcher shares this same port (upgrade path `/_kontexta_ws`), so a single published port is all you need. Data is persisted in `./kontexta-data` on the host. The container is wired with a healthcheck against `/api/health` (returns `{"status":"ok"}` once the SQLite handle is open).

To stop and remove:

```bash
docker compose -f docker-compose.hub.yml down   # keeps ./kontexta-data (Hub)
docker compose down                              # keeps ./kontexta-data (source build)
docker compose down -v                           # also removes volumes (does NOT delete bind-mounted data dir)
```

---

## Onboarding a project: agent context rules

When you register a project with kontexta (via the MCP `register_project` tool), the server inspects the project root for known agent context files and recommends a follow-up so your agent learns kontexta's conventions on day one. Without this, a fresh conversation starts ignorant of which writes belong in the KB, when to journal, how to search, and where specs live.

### What gets detected

| Agent | Path inspected |
| :--- | :--- |
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Gemini | `GEMINI.md` |
| Cursor | `.cursor/rules/*.mdc` |
| Continue | `.continue/rules/*.md` |
| Aider | `.aider.conf.yml`, `.aider/*.md` |

Multiple matches are all surfaced — a repo with both `CLAUDE.md` and `AGENTS.md` (Claude Code + Codex side-by-side) gets the rules block injected into both. Symlinks are skipped defensively.

### The recommendation flow

`register_project` returns a `recommendation` field in its response:

- **Update mode** — one or more context files were detected. The agent surfaces the recommendation, asks the user, and on Yes calls `onboard_agent` with `{ project_id, files: [...] }`.
- **Create mode** — no context file exists. The agent asks which client you want to scaffold for (`claude-code` | `codex` | `gemini` | `cursor` | `continue` | `aider` | `cline` | `copilot` | `generic`) and calls `onboard_agent` with `{ project_id, target_agent }`. The right canonical filename is created with a starter scaffold plus the rules block.

No file is ever written without explicit user consent — the recommendation is plain JSON; the agent must surface it and act on the user's reply.

### The injected block

`onboard_agent` writes a version-fenced block bracketed by HTML comments:

```markdown
<!-- BEGIN kontexta:rules v1.0.0 -->
## Working with kontexta

[…workflow rules: search-before-read, KB writes, spec location,
tagging, whats_new, journaling, restore-via-kontexta, push at end…]
<!-- END kontexta:rules v1.0.0 -->
```

The block is **idempotent** — re-running on the same version is a no-op (`action: "skipped"`). Bumping `RULE_BLOCK_VERSION` in a future kontexta release causes the next call to splice the block in place, preserving every line of your hand-edited content outside the markers. Malformed or duplicate markers are refused with a structured reason rather than silently rewritten.

Writes are atomic (tmp file + rename), and all target paths are containment-checked against the project root.

### Manual invocation

You can refresh the block any time without re-registering the project:

```jsonc
// MCP tool call
{
  "name": "onboard_agent",
  "arguments": {
    "project_id": 42,
    "files": ["CLAUDE.md"]   // or omit + pass target_agent for create mode
  }
}
```

Returns `{ written: [{ path, action, version }], skipped: [{ path, reason }] }`.

---

## Local development

> [!IMPORTANT]
> **Kontexta is a pnpm monorepo.** Do **not** use `npm install` at the workspace root — it will ignore `pnpm-workspace.yaml` and produce a broken `node_modules` layout. You must use **pnpm** (or **corepack**). If you install the MCP server globally via npm (`npm install -g kontexta-mcp`), that is a separate, self-contained package and does not use the monorepo.

### Prerequisites

| Tool | Version | Why |
| :--- | :--- | :--- |
| Node.js | **22.x LTS** (pinned via `.nvmrc`) | Required by Next 15 + React 19. Pinned to 22 to avoid native-module ABI mismatches. |
| pnpm | **9.15.0** (pinned via `packageManager`) | Package manager for the workspace |
| git | 2.20+ | Sync engine shells out via `simple-git` at runtime |
| C/C++ toolchain | platform-specific (see below) | `better-sqlite3` builds a native module on install |

**Node version:** the repo includes a `.nvmrc` pinned to `22`. If you use nvm, run `nvm use` once inside the repo and you'll always be on the right version. Native modules (`better-sqlite3`, `re2`) compile against the active Node ABI — mixing versions across `pnpm install` and `node` invocations causes `ERR_DLOPEN_FAILED`. Avoid switching Node versions after installing; if you do, run `pnpm rebuild re2 better-sqlite3` to recompile.

**Install pnpm** (matches the repo's pinned version):

```bash
# Option A: corepack (ships with Node)
corepack enable && corepack prepare pnpm@9.15.0 --activate

# Option B: npm
npm install -g pnpm@9.15.0
```

**Install the C/C++ toolchain** (only needed for the `better-sqlite3` build during `pnpm install`):

- **Debian/Ubuntu:** `sudo apt install build-essential python3`
- **Fedora/RHEL:** `sudo dnf install gcc-c++ make python3`
- **macOS:** `xcode-select --install`
- **Windows:** Install Visual Studio Build Tools with the "Desktop development with C++" workload

### Repository layout

Kontexta is a pnpm + turbo monorepo:

```
kontexta/
├── apps/
│   ├── web/        # Next.js 15 UI (App Router, React 19, Tailwind)
│   │   └── scripts/dev-lite.sh  # low-memory dev server helper
│   └── mcp/        # MCP stdio server for AI agents
├── packages/
│   └── core/       # SQLite/FTS5, git engine, file watcher (kxta-core)
├── docker-compose.yml      # build from source
├── docker-compose.hub.yml  # pull from Docker Hub (no build)
├── Dockerfile
├── .nvmrc                  # pins Node 22 for native module ABI consistency
├── pnpm-workspace.yaml
└── turbo.json
```

`apps/web` and `apps/mcp` both depend on `kxta-core` via `workspace:*`. The core package must be built once before either app can resolve its imports — `pnpm build` handles this automatically via turbo's dependency graph.

### Install & first build

```bash
git clone <repository-url>
cd kontexta
pnpm install                # installs every workspace package, builds better-sqlite3
pnpm build                  # builds kxta-core first, then apps/web and apps/mcp
```

`pnpm install` may take a few minutes on first run while `better-sqlite3` compiles. If you see a build error here, your toolchain is missing — see Prerequisites.

### Run in development

```bash
pnpm dev
```

This starts:

- Next.js dev server on `http://localhost:3000` (Turbopack hot reload)
- WebSocket file-watcher attached to the same HTTP server at `/_kontexta_ws` (auto-started by `instrumentation.ts`)

> [!TIP]
> **Low-memory machine?** Use `pnpm dev:lite` instead. It runs `next dev` on webpack (skips Turbopack's native engine) and caps Node's heap at 1.5 GB via `--max-old-space-size=1536`. Recommended on Cloud Workstations / small VMs where Turbopack can push the host into OOM. Boots to "Ready" in ~8s on a typical workstation.
>
> `dev:lite` also kills any orphaned `next-server` process left behind by a previous Ctrl-C before starting, so it always binds port 3000 cleanly. If you ever see the server start on `3001` instead, it means a previous dev server is still running — `dev:lite` handles this automatically.
>
> **Cloud Workstations note:** if you see a "Cross origin request" warning about `*.cloudworkstations.dev`, it's harmless — `next.config.ts` already whitelists that domain via `allowedDevOrigins`.

Data is stored in your OS-standard user data directory by default (e.g., `~/.local/share/kontexta` on Linux). See the [Configuration](#configuration) section for exact paths.

To persistently configure the data location, you have two options depending on your scope:

**Global (all tools — `npx`, `pnpm dev`, standalone):** export from your shell profile so every process picks it up:

```bash
# ~/.bashrc or ~/.zshrc
export KONTEXTA_DATA_DIR="$HOME/my-kontexta-vault"
```

Reload your shell (`source ~/.bashrc`) and every Kontexta process — including `npx kontexta-mcp` — will use this vault.

**Repo-local (this checkout only):** create a `.env.local` at the repo root (gitignored):

```bash
# .env.local — picked up automatically by Next.js; pnpm dev only
KONTEXTA_DATA_DIR=/path/to/your/data
```

> [!TIP]
> Use the shell profile export if you run the MCP server via `npx` or from multiple directories. Use `.env.local` when you want a scratch vault isolated to this repo (e.g., `KONTEXTA_DATA_DIR=./data`) without affecting your global setup.


> [!IMPORTANT]
> **Contributors only:** If you're modifying `packages/core` while developing, run `pnpm -C packages/core dev` in a second terminal — it's `tsc --watch` and rebuilds `dist/` on every save. Next dev loads core from `packages/core/dist/`, not from source, so changes won't appear without that watch process.

### Verify the install

With `pnpm dev` running:

1. **UI loads:** open `http://localhost:3000` — the three-pane layout (folder tree / file list / content) renders.
2. **Health endpoint:** `curl http://localhost:3000/api/health` returns `{"status":"ok"}`.
3. **WebSocket connected:** open browser DevTools → Network → WS — a connection to `ws://localhost:3000/_kontexta_ws` (status 101) is open. Footer status bar shows `synced` or `idle` (not red).

### Run in production (standalone, without Docker)

For most users, **Docker is the recommended production path** (see Quick Start above). The compose file already wires the healthcheck, port mapping, and data persistence.

If you need to run standalone (e.g. behind a reverse proxy on a bare-metal host):

```bash
pnpm build

NODE_ENV=production \
KONTEXTA_DATA_DIR=/var/lib/kontexta \
PORT=3000 \
node apps/web/.next/standalone/apps/web/server.js
```

You must also place `apps/web/.next/static/` and `apps/web/public/` adjacent to `server.js` in the standalone tree (the `Dockerfile` shows the exact layout). Reverse-proxy `/` to `:3000` — the WebSocket file-watcher rides on the same port at `/_kontexta_ws`, so make sure your proxy forwards the HTTP `Upgrade` header (nginx: `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`). No second port to publish or proxy.

### Tests

```bash
pnpm test                     # runs vitest across the workspace (currently: packages/core only)
pnpm -C packages/core test    # same, scoped to core
```

Tests create temporary git repos under `packages/core/tests/test-data/` and never touch your real repo or your global git config.

### Updating

```bash
git pull
pnpm install                  # in case dependencies changed
pnpm build                    # rebuild core + apps
```

If `packages/core/src/db/migrations/` gained new `.sql` files, they run automatically the next time the app boots and acquires the SQLite handle.

### Troubleshooting

- **`better-sqlite3` fails to build during `pnpm install`** — install the C/C++ toolchain (see Prerequisites), then `rm -rf node_modules && pnpm install`.
- **`ERR_DLOPEN_FAILED` / "Module did not self-register"** — native module (`better-sqlite3` or `re2`) was compiled for a different Node version. Run `pnpm rebuild re2 better-sqlite3` under the correct Node version. Use `nvm use` to activate the version pinned in `.nvmrc` before rebuilding.
- **`Cannot find module 'kxta-core'`** when starting the web app — you skipped the build step. Run `pnpm -C packages/core build` (or `pnpm build` from the root) once.
- **`database is locked`** in dev — usually a leftover dev process holding the WAL handle. Stop all `pnpm dev` processes; if it persists, remove `kontexta.db-shm` and `kontexta.db-wal` from the data directory and restart.
- **WebSocket not connecting** — the WS shares the web app's HTTP server at path `/_kontexta_ws`, so if the page loads then port reachability is already fine. Check that you're logged in (the WS uses the same `kontexta_session` cookie for auth, browser-side). If you're behind a reverse proxy, confirm it forwards the HTTP `Upgrade` header (nginx: `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).
- **Dev server crashes the host with OOM (low-memory machines / Cloud Workstations)** — use `pnpm dev:lite` instead of `pnpm dev`. It runs webpack instead of Turbopack and caps Node's heap at 1.5 GB so Node fails fast with a recoverable error instead of pushing the VM OOM.
- **Sync fails with "Configured global remote URL is not a valid git remote"** — only `https://`, `http://`, `ssh://`, `git://`, and scp-form (`user@host:path`) URLs are accepted. `file://` and credential helpers are rejected by design.
- **MCP server returns "Database not initialized"** — ensure `KONTEXTA_DATA_DIR` points to the same directory the web UI uses; the MCP server opens its own SQLite handle and reads from `$KONTEXTA_DATA_DIR/kontexta.db`.
- **Build succeeds but `/` shows a placeholder asking for a tablet** — your viewport is below 768px. Kontexta targets tablet+ on the desktop UI; widen the window or open on a larger screen.

---

## Configuration

### Data Storage Summary

In all setups, the `KONTEXTA_DATA_DIR` environment variable is the authoritative override. If not set, the following defaults apply:

| Setup | Default Path | Persistence / Config |
| :--- | :--- | :--- |
| **Docker** | `/app/data` | Persisted via volume (defaults to `./kontexta-data` on the host). |
| **Local / npm** | OS Data Home | `~/.local/share/kontexta` (Linux), `~/Library/Application Support/kontexta` (macOS), or `%APPDATA%\kontexta` (Windows). |
| **Manual Dev** | OS Data Home | Same as Local/npm. You can also use a repo-local `.env.local` to set a custom path for a specific checkout. |

You can customize Kontexta behavior using the following environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `KONTEXTA_DATA_DIR` | Knowledge vault location | OS default (e.g., `~/.local/share/kontexta`) |
| `KONTEXTA_DB_PATH` | Path to the SQLite database | `$KONTEXTA_DATA_DIR/kontexta.db` |
| `PORT` | Web UI port. The WebSocket file-watcher shares this same port at `/_kontexta_ws`. | `3000` |
| `KONTEXTA_WS_ORIGINS` | (Legacy / programmatic.) Comma-separated allowed `Origin` headers for non-browser WS clients. Browsers authenticate via the session cookie and don't need this. | unset |
| `KONTEXTA_WS_TOKEN` | (Legacy / programmatic.) Shared-secret bypass token required as `?token=…` on the WS handshake. Browsers use the short-lived session token from `/api/auth/token` and don't need this. | unset |
| `NEXT_PUBLIC_WS_TOKEN` | Same token, baked into the client bundle at build time. Only set if you've explicitly chosen the static-token auth path. | unset |
| `KONTEXTA_PROJECT_TOKEN_WARN` | Soft cap (in estimated tokens) above which `register_project` and `project_map` add a `warning` to their response. Set to `0` to disable. | `100000` |

The WebSocket file-watcher does not bind its own port — it attaches to Next.js's HTTP server on the same port as the web UI and only handles upgrades to `/_kontexta_ws`. Auth piggybacks on the unified system: browsers send the `kontexta_session` cookie (same-origin, automatic); programmatic clients can use the IP bypass list, the legacy `KONTEXTA_WS_ORIGINS` allowlist, or the legacy `KONTEXTA_WS_TOKEN` shared secret. Connections that don't pass any of these checks are dropped with a `1008` close code. File-path leakage onto the LAN is bounded by the same auth surface that protects the dashboard.

---

## Operations

- **Health check:** `GET /api/health` → `200 {"status":"ok"}` when SQLite responds, `503` otherwise.
- **Global git remote:** only `https://`, `http://`, `ssh://`, `git://`, and scp-form (`user@host:path`) URLs are accepted. `file://` and other helpers are rejected.
- **WebSocket auth:** the WS shares the web app's HTTP server at `/_kontexta_ws`. Browsers authenticate via the same `kontexta_session` cookie used for the dashboard (no extra config). Programmatic clients can authenticate via the IP bypass list, `KONTEXTA_WS_ORIGINS`, or `KONTEXTA_WS_TOKEN` (see Configuration). Failed handshakes are dropped with a `1008` close code.
- **Token estimation:** the file list and content header show `~Nk tok` per file plus per-folder totals. The heuristic samples each file's first 4 KB and switches between `bytes/4` (ASCII-heavy: ~10% accurate) and `bytes/3` (multi-byte: CJK/emoji, more conservative). MCP tool responses include the same `est_tokens` field plus a `total_est_tokens` for list-style tools so agents can budget their context window before pulling content.
- **Minimum viewport:** the UI targets ≥768px. Below that, a placeholder is shown.
