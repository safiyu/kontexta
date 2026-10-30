/**
 * End-to-end encryption for brain payloads.
 *
 * Two keys are derived from the share id (HKDF-SHA256) on the machine: a routing id, which is all the remote ever
 * learns, and an encryption key that never leaves the machine. Op payloads travel as AES-256-GCM envelopes bound to
 * their gid, kind and origin, so the remote relays and stores ciphertext it cannot read or forge.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const SALT = Buffer.from("kontexta-brain-v1", "utf8");

export interface BrainKeys {
  /** 64 hex characters, sent to the remote (which stores only a peppered hash of it). */
  routeId: string;
  /** 32 bytes, never sent anywhere. */
  key: Buffer;
}

export interface PayloadEnvelope {
  e: 1;
  /** base64 of the 12-byte GCM nonce */
  n: string;
  /** base64 of ciphertext followed by the 16-byte auth tag */
  c: string;
}

export function deriveBrainKeys(shareId: Uint8Array): BrainKeys {
  const ikm = Buffer.from(shareId);
  const route = Buffer.from(hkdfSync("sha256", ikm, SALT, "route", 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, SALT, "encrypt", 32));
  return { routeId: route.toString("hex"), key };
}

export function isEnvelope(v: unknown): v is PayloadEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.e === 1 && typeof o.n === "string" && typeof o.c === "string" && o.c.length > 0;
}

function aadFor(gid: string, kind: string, origin: string): Buffer {
  return Buffer.from(`${gid}|${kind}|${origin}`, "utf8");
}

export function encryptPayload(key: Buffer, payload: unknown, gid: string, kind: string, origin: string): PayloadEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(gid, kind, origin));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { e: 1, n: nonce.toString("base64"), c: body.toString("base64") };
}

/** Throws when the envelope was tampered with, belongs to another brain, or is bound to a different gid, kind or origin. */
export function decryptPayload(key: Buffer, envelope: unknown, gid: string, kind: string, origin: string): unknown {
  if (!isEnvelope(envelope)) throw new Error("payload is not an encrypted envelope");
  const nonce = Buffer.from(envelope.n, "base64");
  const raw = Buffer.from(envelope.c, "base64");
  if (nonce.length !== 12 || raw.length < 16) throw new Error("malformed encrypted envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aadFor(gid, kind, origin));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}
