// packages/core/src/util/tokens.ts
// Heuristic token count: ~4 bytes/token for ASCII-ish text, ~3 for multi-byte.
// Same approach used by the MCP server before this was hoisted into core.

export function estimateTokensFromBuffer(buf: Buffer): number {
  if (buf.length === 0) return 1;
  const mostlyAscii = buf.toString("utf-8").length > buf.length * 0.7;
  return Math.max(1, Math.ceil(buf.length / (mostlyAscii ? 4 : 3)));
}

export function estimateTokensFromString(s: string): number {
  return estimateTokensFromBuffer(Buffer.from(s, "utf-8"));
}
