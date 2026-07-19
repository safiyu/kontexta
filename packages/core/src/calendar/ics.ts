import type { CalendarEntity, CalendarEvent } from "./types.js";

/** Convert a UTC ISO 8601 timestamp ("2026-08-01T10:00:00.000Z") to ICS UTC form. */
export function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Escape text per RFC 5545 §3.3.11 (backslash, comma, semicolon, newline). */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Fold a single ICS content line to <=75 octets per line, per RFC 5545 §3.1. */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const limit = first ? 75 : 74; // continuation lines are prefixed with a space
    let end = Math.min(offset + limit, bytes.length);
    // Avoid splitting in the middle of a multi-byte UTF-8 sequence.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
    first = false;
  }
  return parts.join("\r\n ");
}

export interface IcsOptions {
  calendar_name?: string;
}

/**
 * Build an RFC 5545 ICS calendar from events. Times are emitted in UTC
 * ("Z" suffix) so no VTIMEZONE component is required.
 */
export function eventsToIcs(
  events: CalendarEvent[],
  entitiesById: Map<number, CalendarEntity>,
  opts: IcsOptions = {},
): string {
  const calendarName = opts.calendar_name ?? "Kontexta Calendar";
  const lines: string[] = [];

  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Kontexta//Calendar//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`X-WR-CALNAME:${escapeIcsText(calendarName)}`);

  for (const event of events) {
    const entity = entitiesById.get(event.entity_id);
    const entityName = entity?.name ?? `#${event.entity_id}`;

    const descriptionParts: string[] = [];
    if (event.notes) descriptionParts.push(event.notes);
    if (event.source) descriptionParts.push(`Source: ${event.source}`);
    if (event.original_timezone) descriptionParts.push(`Original timezone: ${event.original_timezone}`);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:kontexta-cal-${event.id}@kontexta`);
    lines.push(`DTSTAMP:${toIcsUtc(event.updated_at)}`);
    lines.push(`DTSTART:${toIcsUtc(event.starts_at)}`);
    lines.push(`DTEND:${toIcsUtc(event.ends_at)}`);
    lines.push(`SUMMARY:${escapeIcsText(`[${entityName}] ${event.title}`)}`);
    lines.push(`CATEGORIES:${escapeIcsText(event.type)}`);
    if (descriptionParts.length > 0) {
      lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join("\n"))}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}
