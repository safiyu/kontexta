import RE2 from "re2";
import type { ParamDef } from "./types.js";

const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;
// Default pattern for string params. Anchored at both ends so a value
// can't smuggle a newline + injected payload past a regex like `^[^-].*`
// (which only constrains the first char). First char cannot be `-` (option
// injection) or whitespace; remaining chars are any non-newline.
const DEFAULT_STRING_PATTERN = "^[^-\\s][^\\n\\r]*$";
const MAX_STRING_LENGTH = 8192;
// Block control characters even when a custom pattern would otherwise
// allow them — a tab or backspace inside an argv value tends to surprise
// the receiving program more than it helps.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export function rejectNul(s: string): void {
  if (s.includes("\0")) {
    throw new Error("NUL byte not permitted in param value");
  }
}

export function rejectControl(s: string): void {
  if (CONTROL_CHAR_RE.test(s)) {
    throw new Error("control characters not permitted in param value");
  }
}

export function validateNumber(
  v: unknown,
  bounds?: { min?: number; max?: number }
): void {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`numeric param must be a finite number, got ${String(v)}`);
  }
  if (v < SAFE_INT_MIN || v > SAFE_INT_MAX) {
    throw new Error(`numeric param outside safe-integer range`);
  }
  if (bounds?.min !== undefined && v < bounds.min) {
    throw new Error(`numeric param below min ${bounds.min}`);
  }
  if (bounds?.max !== undefined && v > bounds.max) {
    throw new Error(`numeric param above max ${bounds.max}`);
  }
}

export function validateBoolean(v: unknown): void {
  if (v !== true && v !== false) {
    throw new Error(`boolean param must be true or false, got ${String(v)}`);
  }
}

export function isLiteralArgv0(s: string): boolean {
  return !s.includes("{{");
}

export interface PatternMatcher {
  test(s: string): boolean;
  source: string;
}

export function compilePattern(src: string): PatternMatcher {
  let r: RE2;
  try {
    r = new RE2(src);
  } catch (e: any) {
    throw new Error(`invalid pattern: ${e?.message ?? e}`);
  }
  return { test: (s) => r.test(s), source: src };
}

export function validateParamValue(value: unknown, def: ParamDef): void {
  if (def.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`string param expected, got ${typeof value}`);
    }
    rejectNul(value);
    rejectControl(value);
    // Bytes, not code units — emoji are 2 code units / 4 bytes.
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_LENGTH) {
      throw new Error(`string param exceeds max length of ${MAX_STRING_LENGTH} bytes`);
    }
    if (value === "") return;
    const src = def.pattern ?? DEFAULT_STRING_PATTERN;
    if (!compilePattern(src).test(value)) {
      throw new Error(`param value does not match pattern ${src}`);
    }
    return;
  }
  if (def.type === "number") {
    validateNumber(value, { min: def.min, max: def.max });
    return;
  }
  if (def.type === "boolean") {
    validateBoolean(value);
    return;
  }
  throw new Error(`unknown param type ${(def as any).type}`);
}
