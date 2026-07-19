const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HAS_TZ_RE = /([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an instant, requiring an explicit timezone (mirrors resolveSince in
 * whats-new/index.ts — naive timestamps are ambiguous once stored as UTC).
 * Returns the value normalized to a UTC ISO 8601 string ("...Z").
 */
export function parseInstant(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError(`\`${field}\` is required`);

  const isDateOnly = DATE_ONLY_RE.test(trimmed);
  const hasTz = HAS_TZ_RE.test(trimmed);
  if (!isDateOnly && !hasTz) {
    throw new RangeError(
      `\`${field}\`: naive ISO timestamp without timezone is ambiguous: ${JSON.stringify(value)}. ` +
        `Append "Z" for UTC or "+HH:MM"/"-HH:MM" for an explicit offset (e.g. "2026-01-15T00:00:00Z").`,
    );
  }

  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) {
    throw new RangeError(
      `\`${field}\`: cannot parse ${JSON.stringify(value)}. Expected an ISO 8601 timestamp with an explicit timezone.`,
    );
  }

  return new Date(t).toISOString();
}

/** Validate an IANA timezone name (display-only; no conversion performed). */
export function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new RangeError(`Unknown IANA timezone: ${JSON.stringify(tz)}`);
  }
}

/** Validate that ends_at is strictly after starts_at (both already UTC ISO strings). */
export function assertRange(starts_at: string, ends_at: string): void {
  if (!(ends_at > starts_at)) {
    throw new RangeError(
      `\`ends_at\` (${ends_at}) must be after \`starts_at\` (${starts_at})`,
    );
  }
}
