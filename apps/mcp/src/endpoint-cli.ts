#!/usr/bin/env node
// `kontexta endpoint …`: manage this machine's storage-server connection —
// connect / status / disconnect / push / pull. Ships inside the MCP bundle so
// it reaches kxta-core (and the Phase 4 endpoint client) without a second
// dependency graph, exactly like hooks-cli and connect-cli.
//
// The thin `kontexta endpoint …` wrapper in packages/cli/src/endpoint.ts just
// locates this file next to the MCP entry and execs it. Everything that talks
// to a kontexta-storage-server (spec 1.6) lives in kxta-core's
// storage/client.ts — this module only parses argv, owns the DB connection for
// the invocation, and prints a human- or JSON-friendly report.
import { hostname } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ensureDataDir,
  resetDataDirCache,
  getDatabase,
  closeDatabase,
  getMachineId,
  getMachineLabel,
  listClients,
  connectEndpoint,
  disconnectEndpoint,
  readEndpointConfig,
  pushOutbox,
  pullRemoteOps,
  getSyncCursor,
  pendingCount,
} from "kxta-core";

// kxta-core does not re-export the better-sqlite3 `Database` type, so derive it
// from the handle `getDatabase()` returns (they are the same type). This keeps
// this module free of a direct better-sqlite3 type import.
type Database = ReturnType<typeof getDatabase>;

const USAGE = `kontexta endpoint: manage this machine's storage-server connection

Usage:
  kontexta endpoint connect <url> [token] [--hostname <label>] [--json]
      Verify a storage endpoint and persist the connection. With no token, the
      machine self-registers (POST /clients) and stores the one-time token.
  kontexta endpoint status [--json]
      Show the connection, poll cadence, outbox depth, and sync cursor.
  kontexta endpoint disconnect [--json]
      Clear the stored endpoint + token (the sync loop goes dormant).
  kontexta endpoint push [--json]
      Ship the local outbox to the server (POST /ops).
  kontexta endpoint pull [--json]
      Poll + apply remote ops since the cursor (GET /ops).

Common flags: --data-dir <dir> --timeout <ms>
`;

function print(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

/** Mask a token for display: keep a short prefix/suffix, never the whole secret. */
function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function settingValue(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Self-register this machine with the server (POST /clients) to obtain a
 * one-time sync token. Returns the token when the server issued a new one,
 * or null when the machine is already registered (it holds a token elsewhere).
 */
async function registerClient(
  baseUrl: string,
  machineId: string,
  host: string,
  timeoutMs?: number,
): Promise<string | null> {
  const res = await fetch(`${baseUrl}/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_id: machineId, hostname: host }),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const body = (await res.json().catch(() => null)) as
    | { registered?: unknown; token?: unknown }
    | null;
  if (!res.ok || typeof body !== "object" || body === null) {
    throw new Error(`registerClient: server rejected registration (HTTP ${res.status})`);
  }
  return typeof body.token === "string" && body.token.length > 0 ? body.token : null;
}

/** The `connect` action: resolve a token, then verify + persist via connectEndpoint. */
async function doConnect(
  db: Database,
  url: string,
  token: string | null,
  host: string,
  timeoutMs: number | undefined,
  json: boolean,
): Promise<number> {
  let resolved = token;
  let source = token ? "provided" : "stored";

  if (!resolved) {
    // No token passed: try to self-register (POST /clients).
    try {
      const issued = await registerClient(url, getMachineId(), host, timeoutMs);
      if (issued) {
        resolved = issued;
        source = "registered";
      }
    } catch (e: unknown) {
      // Registration failed (e.g. the machine was registered before). Fall
      // back to any previously stored token rather than hard-failing.
      print(`note: self-registration unavailable (${e instanceof Error ? e.message : e})`);
    }
    if (!resolved) {
      const stored = readEndpointConfig(db).token;
      if (stored) {
        resolved = stored;
        source = "stored";
      } else {
        throw new Error(
          "no token available — pass one after the URL or run `kontexta endpoint connect` first to self-register",
        );
      }
    }
  }

  await connectEndpoint(db, url, resolved, { requestTimeoutMs: timeoutMs });

  const cfg = readEndpointConfig(db);
  if (json) {
    print(JSON.stringify({ connected: true, url: cfg.url, token: maskToken(cfg.token), tokenSource: source }));
  } else {
    print(`connected to ${cfg.url} (token ${maskToken(cfg.token)}, ${source})`);
  }
  return 0;
}

/** The `status` action: connection + cadence + outbox + cursor + identity. */
function doStatus(db: Database, json: boolean): number {
  const cfg = readEndpointConfig(db);
  const report = {
    connected: cfg.connected,
    url: cfg.url,
    token: cfg.connected ? maskToken(cfg.token) : null,
    activePollIntervalMs: cfg.activePollIntervalMs,
    idlePollIntervalMs: cfg.idlePollIntervalMs,
    pendingOps: pendingCount(db),
    syncCursor: getSyncCursor(db),
    machineId: getMachineId(),
    machineLabel: getMachineLabel(),
    clients: listClients().map((c) => ({ machine_id: c.machine_id, hostname: c.hostname, last_seen_at: c.last_seen_at })),
  };
  if (json) {
    print(JSON.stringify(report));
    return 0;
  }
  const state = cfg.connected ? `connected → ${cfg.url}` : "not connected (run `kontexta endpoint connect <url>` to start syncing)";
  print(state);
  if (cfg.connected) print(`  token:  ${maskToken(cfg.token)}`);
  print(`  poll:   ${cfg.activePollIntervalMs}ms active / ${cfg.idlePollIntervalMs}ms idle`);
  print(`  outbox: ${report.pendingOps} pending op(s), cursor at seq ${report.syncCursor}`);
  print(`  machine: ${report.machineId}${report.machineLabel ? ` (${report.machineLabel})` : ""}`);
  return 0;
}

/** The `disconnect` action: clear the credentials. */
function doDisconnect(db: Database, json: boolean): number {
  disconnectEndpoint(db);
  const cfg = readEndpointConfig(db);
  if (json) {
    print(JSON.stringify({ connected: cfg.connected, url: cfg.url }));
  } else {
    print(cfg.connected ? "still connected (credentials not cleared)" : "disconnected — sync loop will go dormant");
  }
  return cfg.connected ? 1 : 0;
}

/** The `push` action: drain the local outbox. */
async function doPush(db: Database, timeoutMs: number | undefined, json: boolean): Promise<number> {
  const result = await pushOutbox(db, { requestTimeoutMs: timeoutMs });
  if (json) {
    print(JSON.stringify(result));
  } else if (result.error) {
    print(`push failed: ${result.error}`);
  } else if (result.attempted === 0) {
    print("outbox empty — nothing to push");
  } else {
    print(`pushed ${result.delivered}/${result.attempted} op(s)${result.conflicts.length ? `, ${result.conflicts.length} conflict(s)` : ""}`);
  }
  for (const c of result.conflicts) print(`  conflict: ${c.gid} (${c.kind})`);
  return result.error ? 1 : 0;
}

/** The `pull` action: poll + apply remote ops. */
async function doPull(db: Database, timeoutMs: number | undefined, json: boolean): Promise<number> {
  const result = await pullRemoteOps(db, { requestTimeoutMs: timeoutMs });
  if (json) {
    print(JSON.stringify({ ...result, conflicts: result.conflicts.map((c) => ({ gid: c.gid, kind: c.kind })) }));
  } else if (result.error) {
    print(`pull failed: ${result.error}`);
  } else {
    print(`pulled ${result.polled} op(s), applied ${result.applied}${result.conflicts.length ? `, ${result.conflicts.length} conflict(s)` : ""}; cursor at seq ${result.cursor}`);
  }
  for (const c of result.conflicts) print(`  conflict: ${c.gid} (${c.kind})`);
  return result.error ? 1 : 0;
}

export async function runEndpointCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      token: { type: "string" },
      hostname: { type: "string" },
      "data-dir": { type: "string" },
      timeout: { type: "string" },
    },
  });
  const [cmd, url, tokenPos] = positionals;
  if (!cmd || !["connect", "status", "disconnect", "push", "pull"].includes(cmd)) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (cmd === "connect" && !url) {
    process.stderr.write("connect: usage `kontexta endpoint connect <url> [token]`\n");
    return 2;
  }
  const timeoutMs = values.timeout !== undefined ? Number(values.timeout) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    process.stderr.write("--timeout must be a positive integer (ms)\n");
    return 2;
  }

  if (values["data-dir"]) {
    process.env.KONTEXTA_DATA_DIR = values["data-dir"];
    resetDataDirCache();
  }
  ensureDataDir();
  const db = getDatabase();

  try {
    switch (cmd) {
      case "connect": {
        const token = values.token ?? tokenPos ?? null;
        const host = values.hostname ?? hostname();
        return await doConnect(db, url as string, token, host, timeoutMs, values.json);
      }
      case "status":
        return doStatus(db, values.json);
      case "disconnect":
        return doDisconnect(db, values.json);
      case "push":
        return await doPush(db, timeoutMs, values.json);
      case "pull":
        return await doPull(db, timeoutMs, values.json);
    }
    return 2;
  } finally {
    closeDatabase();
  }
}

// Only run when executed as a script, not when something imports this module.
function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  runEndpointCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : e}\n`);
      process.exitCode = 1;
    },
  );
}
