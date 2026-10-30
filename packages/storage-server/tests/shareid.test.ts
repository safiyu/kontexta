import { describe, it, expect } from "vitest";
import { generateShareId, formatShareId, parseShareId, hashShareId } from "../src/shareid.js";

describe("share id codec", () => {
  it("round-trips 32 bytes through format and parse", () => {
    const b = generateShareId();
    const s = formatShareId(b);
    expect(s).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(parseShareId(s)).toEqual(b);
  });

  it("accepts lowercase, missing dashes, and O/I/L substitutions", () => {
    const b = new Uint8Array(32).fill(0x08);
    const s = formatShareId(b);
    expect(s).toContain("1");
    const mangled = s.toLowerCase().replace(/-/g, "").replace(/0/g, "o").replace(/1/g, "l");
    expect(parseShareId(mangled)).toEqual(b);
  });

  it("rejects wrong length and non-alphabet characters", () => {
    const s = formatShareId(generateShareId());
    expect(parseShareId(s.slice(0, -1))).toBeNull();
    expect(parseShareId(s + "A")).toBeNull();
    expect(parseShareId(s.replace(/^./, "U"))).toBeNull();
    expect(parseShareId("")).toBeNull();
  });

  it("hashShareId is stable per pepper and differs across peppers", () => {
    const b = generateShareId();
    expect(hashShareId(b, "p1")).toBe(hashShareId(b, "p1"));
    expect(hashShareId(b, "p1")).not.toBe(hashShareId(b, "p2"));
  });
});
