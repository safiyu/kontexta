#!/usr/bin/env node
/**
 * Relay HTTP bootstrap.
 *
 * The thin process entry that the routes (routes/ops.ts) and database
 * (db/index.ts) were built for: it opens the server's standalone SQLite
 * database, mounts the ops router at the root, and owns the HTTP listener
 * and process lifecycle. Nothing in `src/routes` or `src/db` starts a socket
 * — this is the single place that does (and the single place `serve` is
 * called), so the in-process test client (tests/server.test.ts) never touches
 * a listener.
 *
 * It is also the Docker entrypoint (packages/relay/Dockerfile →
 * `node dist/server.js`) and the `pnpm start` target.
 *
 * Configuration (all optional; sensible defaults make `node dist/server.js`
 * work out of the box on the default Docker volume):
 *   PORT                 listen port                     (default 23010)
 *   HOSTNAME             bind address                    (default 0.0.0.0)
 *   KXTA_RELAY_DB      SQLite file path                (default ~/.kontexta-relay/relay.db; the Docker image uses /data)
 *   KXTA_RELAY_PEPPER  HMAC pepper for token hashes    (default DEFAULT_PEPPER)
 *   KXTA_RELAY_ENROLL_SECRET  secret needed to create a brain (joining needs only the share id)
 *   KXTA_RELAY_ALLOW_OPEN_CREATE=1  dev only: create brains without a secret
 *   KXTA_RELAY_ALLOW_DEFAULT_PEPPER=1   allow the default pepper on a non-loopback bind
 *
 * The pepper is the one value a real deployment MUST override: token hashes
 * are bound to it, so a forgotten override means every client token on the
 * default pepper is guessable. See auth.ts.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { openDatabase } from "./db/index.js";
import { createOpsRouter } from "./routes/ops.js";
import { createBrainsRouter } from "./routes/brains.js";
import { DEFAULT_PEPPER } from "./auth.js";
import { VERSION } from "./index.js";

/**
 * The default SQLite path for a bare `npx kontexta-relay` or `node dist/server.js` run: a folder in the user's home,
 * created on demand. The Docker image sets `KXTA_RELAY_DB=/data/kontexta-relay.db` so its volume holds the data.
 */
export function defaultDbPath(): string {
  return join(homedir(), ".kontexta-relay", "relay.db");
}

/** The default bind port (spec: the relay is the sibling of the web app on 23002). */
export const DEFAULT_PORT = 23010;

/**
 * Locate db/schema.sql across the deployment shapes, for the startup log.
 * `openDatabase` already resolves and applies it; this is a best-effort
 * duplicate used only to print where the schema came from. Returns null when
 * it cannot be found (the real error surfaces from openDatabase).
 */
function locateSchemaPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "db", "schema.sql"), // dist/db/.. (built layout, /app in Docker)
    join(here, "..", "src", "db", "schema.sql"), // src/db/index.js (source layout)
    join(process.cwd(), "packages", "relay", "src", "db", "schema.sql"), // WORKDIR=/app
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parse a PORT env var, falling back to `fallback` on any malformed value. */
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

/**
 * Build the full Hono application (router + top-level 404 + error handler).
 * Exported separately from `main` so a test or a different host (e.g. a
 * serverless adapter) can reuse the exact app the Docker image serves
 * without starting a listener.
 */
export function createApp(db: ReturnType<typeof openDatabase>): Hono {
  const app = new Hono();
  const pepper = process.env.KXTA_RELAY_PEPPER || DEFAULT_PEPPER;
  app.route("/", createOpsRouter(db, { pepper }));
  app.route(
    "/",
    createBrainsRouter(db, {
      pepper,
      enrollSecret: process.env.KXTA_RELAY_ENROLL_SECRET || "",
      allowOpenCreate: process.env.KXTA_RELAY_ALLOW_OPEN_CREATE === "1",
    }),
  );

  // The router declares no notFound/error handlers (it returns `router` with
  // only its four routes), so the top-level app owns both — a 404 for the
  // unknown paths and a JSON 500 that never leaks the stack to a client.
  app.notFound((c) =>
    c.json(
      {
        error: "not found",
        path: c.req.path,
      },
      404,
    ),
  );
  app.onError((err, c) => {
    process.stderr.write(`relay: unhandled error: ${err.stack ?? String(err)}\n`);
    return c.json({ error: "internal server error" }, 500);
  });
  return app;
}

/** True for loopback bind addresses. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/** Startup guard: the default pepper is only tolerated on a loopback bind (or an explicit override). */
export function defaultPepperRefusal(
  usingDefaultPepper: boolean,
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!usingDefaultPepper || isLoopbackHost(hostname)) return null;
  if (env.KXTA_RELAY_ALLOW_DEFAULT_PEPPER === "1") return null;
  return (
    `refusing to listen on ${hostname} with the default token pepper: set KXTA_RELAY_PEPPER ` +
    "(or KXTA_RELAY_ALLOW_DEFAULT_PEPPER=1 to override)"
  );
}

/**
 * Open the database, build the app, and bind the HTTP listener.
 *
 * Never throws for a bad config — it prints the problem and `process.exit(1)`,
 * which is what a container orchestrator (and `pnpm start`) needs: a clean
 * non-zero exit, not an unhandled rejection.
 */
export function main(): void {
  const port = parsePort(process.env.PORT, DEFAULT_PORT);
  const hostname = process.env.HOSTNAME || "0.0.0.0";
  const dbPath = process.env.KXTA_RELAY_DB || defaultDbPath();
  const usingDefaultPepper = !process.env.KXTA_RELAY_PEPPER;

  const refusal = defaultPepperRefusal(usingDefaultPepper, hostname);
  if (refusal) {
    process.stderr.write(`relay: ${refusal}\n`);
    process.exit(1);
  }

  let db;
  try {
    db = openDatabase(dbPath);
  } catch (e) {
    process.stderr.write(
      `relay: could not open database at ${dbPath}: ${e instanceof Error ? e.message : e}\n`,
    );
    process.exit(1);
  }

  const app = createApp(db);
  const schemaPath = locateSchemaPath();

  // `serve` returns the node:http server; a failed bind (EADDRINUSE / bad
  // port) is reported by the server's 'error' event, not a thrown promise —
  // surface it as a clean exit rather than a crash dump.
  const server = serve({ fetch: app.fetch, port, hostname });
  server.on("error", (e: Error & { code?: string }) => {
    process.stderr.write(`relay: failed to bind ${hostname}:${port}: ${e.code ?? e.message}\n`);
    process.exit(1);
  });
  server.on("listening", () => {
    const addr = server.address();
    process.stdout.write(
      `kontexta-relay v${VERSION} listening on ${hostname}:${addr && typeof addr === "object" ? addr.port : port} ` +
        `(db: ${dbPath})\n`,
    );
    if (schemaPath) {
      process.stdout.write(`  schema: ${schemaPath}\n`);
    }
    if (usingDefaultPepper) {
      process.stdout.write(
        "  WARNING: using the DEFAULT token pepper — set KXTA_RELAY_PEPPER for any real deployment.\n",
      );
    }
  });
}

// Entry guard: only run when executed directly (`node dist/server.js`), not
// when a test or host imports `main` / `createApp`.
function isMain(): boolean {
  try {
    const entry = process.argv[1];
    return !!entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  main();
}
