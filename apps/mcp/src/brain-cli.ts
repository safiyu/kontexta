#!/usr/bin/env node
// `kontexta brain ...`: connect this machine to a brain on a relay and manage that connection.
// Ships inside the MCP bundle so it reaches kxta-core without a second dependency graph (like hooks-cli).
import { hostname } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  ensureDataDir,
  resetDataDirCache,
  getDatabase,
  closeDatabase,
  joinBrain,
  disconnectBrain,
  readBrainConfig,
  revealShareId,
  maskShareId,
  fetchBrainStatus,
  removeBrainMachine,
  bootstrapIfNeeded,
  pushOutbox,
  pullRemoteOps,
  startSyncLoop,
  stopSyncLoop,
  getSyncCursor,
  pendingCount,
} from "kxta-core";

type Database = ReturnType<typeof getDatabase>;

const USAGE = `kontexta brain: connect this machine to a brain on a relay

Usage:
  kontexta brain connect <url> [--share-id <id> | --create [--name <n>]] [--enroll-secret <s>]
                               [--hostname <label>] [--no-keep-share-id] [--json]
      Join a brain with its share id, or create a new one (needs the relay's enrollment secret via
      --enroll-secret or KXTA_RELAY_ENROLL_SECRET). With neither flag you are asked.
  kontexta brain status [--json]
      Brain name, remote, machines, outbox depth, skipped ops and sync cursor.
  kontexta brain share [--yes]
      Show the full share id (anyone who has it can join this brain).
  kontexta brain machines [remove <machine-id>]
      List the machines in this brain, or revoke one.
  kontexta brain disconnect [--json]
      Forget the relay and token. The brain's history stays on this machine.
  kontexta brain push | pull
      Ship the local outbox, or poll and apply ops from your other machines.
  kontexta brain run
      Run the sync loop in the foreground until interrupted.

Common flags: --data-dir <dir> --timeout <ms>
`;

function print(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function skippedCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM sync_skipped_ops WHERE skipped = 1").get() as { n: number }).n;
}

async function doConnect(
  db: Database,
  url: string,
  v: { shareId?: string; create: boolean; name?: string; enrollSecret?: string; host: string; keep: boolean; timeoutMs?: number; json: boolean },
): Promise<number> {
  let shareId = v.shareId;
  let create = v.create;
  if (!shareId && !create) {
    if (!process.stdin.isTTY) {
      process.stderr.write("connect: pass --share-id <id> to join a brain or --create to make a new one\n");
      return 2;
    }
    const answer = await ask("Paste a share id to join a brain, or press Enter to create a new one: ");
    if (answer) shareId = answer;
    else create = true;
  }
  const result = await joinBrain(db, url, {
    shareId,
    create,
    name: v.name,
    hostname: v.host,
    enrollSecret: v.enrollSecret,
    keepShareId: v.keep,
    requestTimeoutMs: v.timeoutMs,
  });
  const boot = await bootstrapIfNeeded(db, { requestTimeoutMs: v.timeoutMs });
  const cfg = readBrainConfig(db);
  if (v.json) {
    print(JSON.stringify({ connected: true, brain: cfg.name, remote: cfg.remoteUrl, created: result.created, shareId: result.created ? result.shareId : undefined, bootstrap: boot }));
    return 0;
  }
  print(`${result.created ? "created" : "joined"} brain "${cfg.name}" on ${cfg.remoteUrl}`);
  if (result.created) {
    print(`share id: ${result.shareId}`);
    print("Save this share id somewhere safe. Anyone who has it can join this brain, and Kontexta cannot recover it for you.");
  }
  if (boot) print(`bootstrapped (${boot.mode}): applied ${boot.applied}, conflicts ${boot.forked}, skipped ${boot.skipped}; cursor ${boot.cursor}`);
  return 0;
}

async function doStatus(db: Database, json: boolean): Promise<number> {
  const cfg = readBrainConfig(db);
  const remote = cfg.connected ? await fetchBrainStatus(db) : null;
  const kept = revealShareId(db);
  const data = {
    connected: cfg.connected,
    brain: cfg.name || null,
    remote: cfg.connected ? cfg.remoteUrl : null,
    shareId: kept ? maskShareId(kept) : cfg.shareHash ? `(not kept on this machine, hash ${cfg.shareHash.slice(0, 8)})` : null,
    machines: remote?.machines ?? null,
    pending: pendingCount(db),
    skipped: skippedCount(db),
    cursor: getSyncCursor(db),
  };
  if (json) {
    print(JSON.stringify(data));
    return 0;
  }
  print(cfg.connected ? `connected to brain "${cfg.name}" on ${cfg.remoteUrl}` : "not connected (run `kontexta brain connect <url>`)");
  if (data.shareId) print(`  share id: ${data.shareId}`);
  if (remote) {
    print("  machines:");
    for (const m of remote.machines) print(`    ${m.machine_id}  ${m.hostname ?? "-"}  last seen ${new Date(m.last_seen_at).toISOString()}`);
  } else if (cfg.connected) {
    print("  machines: relay unreachable");
  }
  print(`  pending ops: ${data.pending}   skipped ops: ${data.skipped}   cursor: ${data.cursor}`);
  return 0;
}

async function doShare(db: Database, yes: boolean): Promise<number> {
  const shareId = revealShareId(db);
  if (!shareId) {
    process.stderr.write("this machine did not keep the share id (it was joined with --no-keep-share-id)\n");
    return 1;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write("pass --yes to print the share id without a prompt\n");
      return 2;
    }
    if ((await ask("Anyone who has the share id can join this brain. Show it? [y/N] ")).toLowerCase() !== "y") return 1;
  }
  print(shareId);
  return 0;
}

async function doMachines(db: Database, rest: string[], json: boolean): Promise<number> {
  if (rest[0] === "remove") {
    if (!rest[1]) {
      process.stderr.write("machines remove: usage `kontexta brain machines remove <machine-id>`\n");
      return 2;
    }
    const ok = await removeBrainMachine(db, rest[1]);
    print(ok ? `revoked ${rest[1]}` : `no such machine in this brain: ${rest[1]}`);
    return ok ? 0 : 1;
  }
  const remote = await fetchBrainStatus(db);
  if (!remote) {
    process.stderr.write("could not reach the relay (not connected, or offline)\n");
    return 1;
  }
  if (json) print(JSON.stringify(remote.machines));
  else for (const m of remote.machines) print(`${m.machine_id}  ${m.hostname ?? "-"}  last seen ${new Date(m.last_seen_at).toISOString()}  acked ${m.acked_seq}`);
  return 0;
}

async function doPush(db: Database, timeoutMs: number | undefined, json: boolean): Promise<number> {
  await bootstrapIfNeeded(db, { requestTimeoutMs: timeoutMs });
  const result = await pushOutbox(db, { requestTimeoutMs: timeoutMs });
  if (json) print(JSON.stringify(result));
  else if (result.error) print(`push failed: ${result.error}`);
  else if (result.attempted === 0) print("outbox empty, nothing to push");
  else print(`pushed ${result.delivered}/${result.attempted} op(s)${result.conflicts.length ? `, ${result.conflicts.length} conflict(s)` : ""}`);
  for (const c of result.conflicts) print(`  conflict: ${c.gid} (${c.kind})`);
  return result.error ? 1 : 0;
}

async function doPull(db: Database, timeoutMs: number | undefined, json: boolean): Promise<number> {
  await bootstrapIfNeeded(db, { requestTimeoutMs: timeoutMs });
  const result = await pullRemoteOps(db, { requestTimeoutMs: timeoutMs });
  if (json) print(JSON.stringify({ ...result, conflicts: result.conflicts.map((c) => ({ gid: c.gid, kind: c.kind })) }));
  else if (result.error) print(`pull failed: ${result.error}`);
  else print(`pulled ${result.polled} op(s), applied ${result.applied}${result.skipped ? `, skipped ${result.skipped}` : ""}${result.conflicts.length ? `, ${result.conflicts.length} conflict(s)` : ""}; cursor at seq ${result.cursor}`);
  for (const c of result.conflicts) print(`  conflict: ${c.gid} (${c.kind})`);
  return result.error ? 1 : 0;
}

async function doRun(db: Database): Promise<number> {
  startSyncLoop(db);
  print(`sync loop running (${readBrainConfig(db).connected ? "connected" : "not connected, dormant"}); Ctrl+C to stop`);
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, 1 << 30);
    const stop = (): void => {
      clearInterval(keepAlive);
      stopSyncLoop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

export async function runBrainCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      create: { type: "boolean", default: false },
      "no-keep-share-id": { type: "boolean", default: false },
      "share-id": { type: "string" },
      name: { type: "string" },
      hostname: { type: "string" },
      "enroll-secret": { type: "string" },
      "data-dir": { type: "string" },
      timeout: { type: "string" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || !["connect", "status", "share", "machines", "disconnect", "push", "pull", "run"].includes(cmd)) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (cmd === "connect" && !rest[0]) {
    process.stderr.write("connect: usage `kontexta brain connect <url> [--share-id <id> | --create]`\n");
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
      case "connect":
        return await doConnect(db, rest[0], {
          shareId: values["share-id"],
          create: values.create,
          name: values.name,
          enrollSecret: values["enroll-secret"] ?? env.KXTA_RELAY_ENROLL_SECRET,
          host: values.hostname ?? hostname(),
          keep: !values["no-keep-share-id"],
          timeoutMs,
          json: values.json,
        });
      case "status":
        return await doStatus(db, values.json);
      case "share":
        return await doShare(db, values.yes);
      case "machines":
        return await doMachines(db, rest, values.json);
      case "disconnect":
        disconnectBrain(db);
        print(values.json ? JSON.stringify({ connected: false }) : "disconnected; the brain's history stays on this machine");
        return 0;
      case "push":
        return await doPush(db, timeoutMs, values.json);
      case "pull":
        return await doPull(db, timeoutMs, values.json);
      case "run":
        return await doRun(db);
    }
    return 2;
  } finally {
    closeDatabase();
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  runBrainCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : e}\n`);
      process.exitCode = 1;
    },
  );
}
