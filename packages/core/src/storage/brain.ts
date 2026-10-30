/**
 * Machine-side brain connection: configuration, the join flow, and the optional stored share id.
 *
 * A machine is connected when `remote_url`, `remote_token` and `brain_share_hash` are all set. The share id
 * itself is the brain's secret, so it is only kept (encrypted with the machine secret) when the user asks.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import { fetchJson, DEFAULT_REQUEST_TIMEOUT_MS } from "./http.js";
import { formatShareId, generateShareId, parseShareId } from "./shareid.js";
import { deriveBrainKeys } from "./crypto.js";

export const ACTIVE_POLL_INTERVAL_DEFAULT_MS = 15_000;
export const IDLE_POLL_INTERVAL_DEFAULT_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 1_000;

export function settingValue(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function settingUpsert(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function settingDelete(db: Database, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** A malformed persisted interval falls back rather than wedging the sync loop. */
function parseInterval(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_POLL_INTERVAL_MS ? n : fallback;
}

/** Trim, require an explicit http(s) scheme, strip trailing slashes; anything else throws. */
export function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("normalizeBaseUrl: URL must be a non-empty string");
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`normalizeBaseUrl: not a valid URL: "${raw}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`normalizeBaseUrl: unsupported protocol "${u.protocol}" (http/https only)`);
  }
  return u.toString().replace(/\/+$/, "");
}

export interface BrainConfig {
  /** True iff the remote URL, the machine token and the brain's share hash are all set. */
  connected: boolean;
  remoteUrl: string;
  token: string;
  shareHash: string;
  name: string;
  activePollIntervalMs: number;
  idlePollIntervalMs: number;
}

export function readBrainConfig(db: Database): BrainConfig {
  const remoteUrl = settingValue(db, "remote_url") ?? "";
  const token = settingValue(db, "remote_token") ?? "";
  const shareHash = settingValue(db, "brain_share_hash") ?? "";
  return {
    connected: remoteUrl.length > 0 && token.length > 0 && shareHash.length > 0,
    remoteUrl,
    token,
    shareHash,
    name: settingValue(db, "brain_name") ?? "",
    activePollIntervalMs: parseInterval(settingValue(db, "poll_active_interval_ms"), ACTIVE_POLL_INTERVAL_DEFAULT_MS),
    idlePollIntervalMs: parseInterval(settingValue(db, "poll_idle_interval_ms"), IDLE_POLL_INTERVAL_DEFAULT_MS),
  };
}

// The key sits in the same database as the ciphertext: this hides the share id from casual disclosure, not from a copied database.
function machineKey(db: Database): Buffer {
  const secret = settingValue(db, "machine_secret");
  if (!secret) throw new Error("machine_secret is missing; run the database migrations");
  return createHash("sha256").update(secret, "utf8").digest();
}

function sealSetting(db: Database, key: string, bytes: Uint8Array): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", machineKey(db), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  settingUpsert(db, key, [iv, cipher.getAuthTag(), enc].map((b) => b.toString("hex")).join(":"));
}

function unsealSetting(db: Database, key: string): Buffer | null {
  const stored = settingValue(db, key);
  if (!stored) return null;
  try {
    const [iv, tag, enc] = stored.split(":").map((h) => Buffer.from(h, "hex"));
    const decipher = createDecipheriv("aes-256-gcm", machineKey(db), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    return null;
  }
}

/** Keep the share id on this machine, encrypted with the machine secret (AES-256-GCM). */
export function storeShareId(db: Database, bytes: Uint8Array): void {
  sealSetting(db, "brain_share_id_enc", bytes);
}

/** The formatted share id if this machine kept it, else null. */
export function revealShareId(db: Database): string | null {
  const bytes = unsealSetting(db, "brain_share_id_enc");
  return bytes && bytes.length === 32 ? formatShareId(new Uint8Array(bytes)) : null;
}

/** The brain's encryption key. Always kept: without it this machine could neither push nor read ops. */
export function storeBrainKey(db: Database, key: Buffer): void {
  sealSetting(db, "brain_enc_key_enc", key);
}

export function readBrainKey(db: Database): Buffer | null {
  const key = unsealSetting(db, "brain_enc_key_enc");
  return key && key.length === 32 ? key : null;
}

/** Clear the connection; the share hash, cursor and known versions stay so the same brain resumes. */
export function disconnectBrain(db: Database): void {
  settingDelete(db, "remote_url");
  settingDelete(db, "remote_token");
}

export interface JoinBrainOptions {
  /** A share id to join; omit with `create` to generate a new brain. */
  shareId?: string;
  create?: boolean;
  name?: string;
  hostname: string;
  /** Needed only to create a brain. */
  enrollSecret?: string;
  /** Keep the share id (encrypted) on this machine so `brain share` can show it later. Default true. */
  keepShareId?: boolean;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface JoinBrainResult {
  created: boolean;
  name: string;
  shareId: string;
  latestSeq: number;
  sameBrainAsBefore: boolean;
}

/** Create or join a brain on a remote. Nothing is persisted unless the whole flow succeeds. */
export async function joinBrain(db: Database, remoteUrl: string, opts: JoinBrainOptions): Promise<JoinBrainResult> {
  const url = normalizeBaseUrl(remoteUrl);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const bytes = opts.shareId !== undefined ? parseShareId(opts.shareId) : opts.create ? generateShareId() : null;
  if (bytes === null) {
    throw new Error(opts.shareId !== undefined ? "joinBrain: that is not a valid share id" : "joinBrain: pass a share id or ask to create a brain");
  }
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const health = await fetchJson(fetchImpl, `${url}/health`, undefined, { timeoutMs });
  if (health.status !== 200) throw new Error(`joinBrain: health check failed (HTTP ${health.status})`);
  const service = (health.body as { service?: unknown } | null)?.service;
  if (service !== "kontexta-brain-host") throw new Error(`joinBrain: ${url} is not a kontexta brain host`);

  const machineId = settingValue(db, "machine_id") ?? "";
  let res;
  try {
    res = await fetchJson(fetchImpl, `${url}/brains/join`, undefined, {
      headers: { "content-type": "application/json", ...(opts.enrollSecret ? { "x-enroll-secret": opts.enrollSecret } : {}) },
      body: JSON.stringify({ route_id: deriveBrainKeys(bytes).routeId, machine_id: machineId, hostname: opts.hostname, name: opts.name }),
      timeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The server may have created the brain before the connection dropped; a generated id would be lost otherwise.
    throw new Error(
      opts.create && opts.shareId === undefined
        ? `joinBrain: request failed (${msg}). If the remote created the brain, join it with share id ${formatShareId(bytes)}`
        : `joinBrain: request failed (${msg})`,
    );
  }
  const body = res.body as { token?: unknown; name?: unknown; created?: unknown; latest_seq?: unknown; error?: unknown } | null;
  if ((res.status !== 200 && res.status !== 201) || typeof body?.token !== "string") {
    throw new Error(`joinBrain: ${typeof body?.error === "string" ? body.error : `server answered HTTP ${res.status}`}`);
  }

  const shareHash = createHash("sha256").update(bytes).digest("hex");
  const sameBrainAsBefore = (settingValue(db, "brain_share_hash") ?? "") === shareHash;
  const name = typeof body.name === "string" ? body.name : "";
  db.transaction(() => {
    settingUpsert(db, "remote_url", url);
    settingUpsert(db, "remote_token", body.token as string);
    settingUpsert(db, "brain_name", name);
    settingUpsert(db, "brain_share_hash", shareHash);
    storeBrainKey(db, deriveBrainKeys(bytes).key);
    if (opts.keepShareId === false) settingDelete(db, "brain_share_id_enc");
    else storeShareId(db, bytes);
    if (!sameBrainAsBefore) {
      // A different brain starts from scratch: local history is pushed again and the remote is merged in.
      db.prepare("UPDATE sync_cursor SET last_seq = 0, updated_at = ? WHERE id = 1").run(Date.now());
      db.prepare("DELETE FROM gid_versions").run();
      db.prepare("DELETE FROM sync_skipped_ops").run();
      db.prepare(
        `UPDATE outbox SET status = 'pending', server_seq = NULL, attempts = 0, next_attempt_at = NULL,
           base_version = CASE WHEN base_version IS NULL THEN NULL ELSE 0 END
         WHERE status IN ('acked', 'sent', 'failed')`,
      ).run();
      settingUpsert(db, "brain_bootstrap_pending", "1");
      settingDelete(db, "brain_bootstrap_after");
      settingDelete(db, "brain_bootstrap_latest");
      settingDelete(db, "brain_bootstrap_deferred");
    }
  })();

  return {
    created: body.created === true,
    name,
    shareId: formatShareId(bytes),
    latestSeq: typeof body.latest_seq === "number" ? body.latest_seq : 0,
    sameBrainAsBefore,
  };
}

export interface BrainRemoteStatus {
  brain_id: number;
  name: string;
  latest_seq: number;
  machines: Array<{ machine_id: string; hostname: string | null; last_seen_at: number; acked_seq: number }>;
}

export interface RemoteCallOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** The remote's view of this brain, or null when not connected or the remote is unreachable. */
export async function fetchBrainStatus(db: Database, opts: RemoteCallOptions = {}): Promise<BrainRemoteStatus | null> {
  const cfg = readBrainConfig(db);
  if (!cfg.connected) return null;
  try {
    const res = await fetchJson(opts.fetchImpl ?? globalThis.fetch, `${cfg.remoteUrl}/brains/me`, undefined, {
      headers: { authorization: `Bearer ${cfg.token}` },
      timeoutMs: opts.requestTimeoutMs,
    });
    return res.status === 200 ? (res.body as BrainRemoteStatus) : null;
  } catch {
    return null;
  }
}

/** Revoke a machine's access to this brain; true when the remote removed it. */
export async function removeBrainMachine(db: Database, machineId: string, opts: RemoteCallOptions = {}): Promise<boolean> {
  const cfg = readBrainConfig(db);
  if (!cfg.connected) throw new Error("not connected to a brain");
  const res = await fetchJson(opts.fetchImpl ?? globalThis.fetch, `${cfg.remoteUrl}/brains/me/machines/${encodeURIComponent(machineId)}`, undefined, {
    method: "DELETE",
    headers: { authorization: `Bearer ${cfg.token}` },
    timeoutMs: opts.requestTimeoutMs,
  });
  return res.status === 204;
}

/** First and last group of a formatted share id, for display; the middle stays hidden. */
export function maskShareId(formatted: string): string {
  const groups = formatted.split("-");
  return groups.length < 3 ? "****" : `${groups[0]}-...-${groups[groups.length - 1]}`;
}
