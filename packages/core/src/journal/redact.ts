export interface RedactConfig {
  blockedKeyRegex: RegExp;
  extraKeys: string[];
  maxArgSizeBytes: number;
}

export const defaultRedactConfig: RedactConfig = {
  blockedKeyRegex: /(password|token|secret|auth|cookie|bearer|api[_-]?key)/i,
  extraKeys: [],
  maxArgSizeBytes: 1024,
};

const REDACTED = "<redacted>";

export function redactArgs(
  value: unknown,
  config: RedactConfig,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // Top-level must be an object for the public API.
    return {};
  }
  return redactObject(value as Record<string, unknown>, config) as Record<string, unknown>;
}

function redact(value: unknown, config: RedactConfig): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > config.maxArgSizeBytes) return `<truncated:${bytes}B>`;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, config));
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>, config);
  return value;
}

function redactObject(obj: Record<string, unknown>, config: RedactConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extra = new Set(config.extraKeys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(obj)) {
    if (config.blockedKeyRegex.test(k) || extra.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, config);
    }
  }
  return out;
}
