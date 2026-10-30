import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { deriveBrainKeys, encryptPayload, decryptPayload, isEnvelope } from "../../src/storage/crypto.js";

const G = "1@aaaaaaaaaaaaaaaa";
const O = "aaaaaaaaaaaaaaaa";

describe("brain payload encryption", () => {
  it("derives a stable routing id and key that differ from each other and per share id", () => {
    const a = randomBytes(32);
    const k1 = deriveBrainKeys(a);
    const k2 = deriveBrainKeys(a);
    expect(k1.routeId).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).toEqual(k2);
    expect(k1.routeId).not.toBe(k1.key.toString("hex"));
    expect(deriveBrainKeys(randomBytes(32)).routeId).not.toBe(k1.routeId);
  });

  it("round-trips a payload and never exposes it in the envelope", () => {
    const { key } = deriveBrainKeys(randomBytes(32));
    const env = encryptPayload(key, { content: "api key sk-live-123" }, G, "file.update", O);
    expect(isEnvelope(env)).toBe(true);
    expect(JSON.stringify(env)).not.toContain("sk-live-123");
    expect(decryptPayload(key, env, G, "file.update", O)).toEqual({ content: "api key sk-live-123" });
  });

  it("uses a fresh nonce for every encryption", () => {
    const { key } = deriveBrainKeys(randomBytes(32));
    const a = encryptPayload(key, { x: 1 }, G, "file.update", O);
    const b = encryptPayload(key, { x: 1 }, G, "file.update", O);
    expect(a.n).not.toBe(b.n);
    expect(a.c).not.toBe(b.c);
  });

  it("rejects the wrong key, a different gid, kind or origin, and tampered ciphertext", () => {
    const { key } = deriveBrainKeys(randomBytes(32));
    const env = encryptPayload(key, { x: 1 }, G, "file.update", O);
    expect(() => decryptPayload(deriveBrainKeys(randomBytes(32)).key, env, G, "file.update", O)).toThrow();
    expect(() => decryptPayload(key, env, "2@aaaaaaaaaaaaaaaa", "file.update", O)).toThrow();
    expect(() => decryptPayload(key, env, G, "file.create", O)).toThrow();
    expect(() => decryptPayload(key, env, G, "file.update", "bbbbbbbbbbbbbbbb")).toThrow();
    const raw = Buffer.from(env.c, "base64");
    raw[0] ^= 1;
    expect(() => decryptPayload(key, { ...env, c: raw.toString("base64") }, G, "file.update", O)).toThrow();
  });

  it("rejects plaintext and malformed envelopes", () => {
    const { key } = deriveBrainKeys(randomBytes(32));
    expect(isEnvelope({ path: "x" })).toBe(false);
    expect(() => decryptPayload(key, { path: "x" }, G, "file.update", O)).toThrow(/not an encrypted envelope/);
    expect(() => decryptPayload(key, { e: 1, n: "AAAA", c: "AAAA" }, G, "file.update", O)).toThrow();
  });
});
