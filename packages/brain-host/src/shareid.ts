import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHARE_BYTES = 32;
const SHARE_SYMBOLS = 52;

/** 32 random bytes: the brain's identifier and its secret. */
export function generateShareId(): Uint8Array {
  return new Uint8Array(randomBytes(SHARE_BYTES));
}

/** Crockford base32, uppercase, 52 symbols in groups of 4 separated by "-". */
export function formatShareId(bytes: Uint8Array): string {
  if (bytes.length !== SHARE_BYTES) throw new Error("share id must be 32 bytes");
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** Accepts lowercase, missing dashes and O/I/L look-alikes; null for anything else. */
export function parseShareId(text: string): Uint8Array | null {
  const clean = text.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  if (clean.length !== SHARE_SYMBOLS) return null;
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (out.length !== SHARE_BYTES || acc !== 0) return null;
  return new Uint8Array(out);
}

/** Peppered hash the server stores in place of the share id. */
export function hashShareId(bytes: Uint8Array, pepper: string): string {
  return createHmac("sha256", pepper).update(bytes).digest("hex");
}
