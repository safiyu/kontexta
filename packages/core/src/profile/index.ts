export const REQUIRED_SECTIONS = ["Name", "Role", "Vision", "Roadmap", "Preferences", "Notes"] as const;

export function profileRelPath(): string {
  return "knowledge/profile.md";
}

/** Return required `##` headings absent from the content. */
export function getMissingSections(content: string): string[] {
  return REQUIRED_SECTIONS.filter((h) => !hasHeading(content, h));
}

/**
 * Insert any missing required `##` headings at their canonical position with empty body.
 * Existing section bodies and ordering are preserved. The H1 `# Profile` is added if missing.
 * Custom sections (non-required `##` headings) are preserved and appended after required sections.
 * Text appearing before the first `##` heading (after `# Profile`) is preserved as preamble.
 */
export function repairProfile(content: string): { content: string; repaired: string[] } {
  const repaired: string[] = [];
  let working = content;

  // Ensure H1 exists at the top.
  if (!/^#\s+Profile\s*$/m.test(working)) {
    working = `# Profile\n\n${working.replace(/^\s+/, "")}`;
  }

  // Parse existing sections into a map: heading -> body (without trailing newline).
  const existing = parseSections(working);

  // Extract preamble: text between `# Profile` and the first `##` heading.
  const preamble = extractPreamble(working);

  // Identify custom sections (non-required headings in their original order).
  const customSections = parseSectionsWithOrder(working).filter(
    (h) => !REQUIRED_SECTIONS.includes(h as (typeof REQUIRED_SECTIONS)[number])
  );

  // Rebuild in canonical order, taking existing bodies where present.
  const lines: string[] = ["# Profile", ""];
  if (preamble.trim().length > 0) {
    lines.push(preamble.trim());
    lines.push("");
  }
  for (const heading of REQUIRED_SECTIONS) {
    lines.push(`## ${heading}`);
    if (existing.has(heading)) {
      const body = existing.get(heading)!;
      if (body.trim().length > 0) {
        lines.push(body.replace(/\n+$/, ""));
      }
    } else {
      repaired.push(heading);
    }
    lines.push("");
  }

  // Append custom sections after required sections.
  for (const heading of customSections) {
    lines.push(`## ${heading}`);
    const body = existing.get(heading)!;
    if (body.trim().length > 0) {
      lines.push(body.replace(/\n+$/, ""));
    }
    lines.push("");
  }

  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";

  return { content: next, repaired };
}

export function assembleProfile(sections: {
  name: string; role: string; vision: string; roadmap: string; preferences: string; notes: string;
}): string {
  const body = [
    "# Profile",
    "",
    "## Name",
    sections.name.trim(),
    "",
    "## Role",
    sections.role.trim(),
    "",
    "## Vision",
    sections.vision.trim(),
    "",
    "## Roadmap",
    sections.roadmap.trim(),
    "",
    "## Preferences",
    sections.preferences.trim(),
    "",
    "## Notes",
    sections.notes.trim(),
    "",
  ];
  return body.join("\n").replace(/\n{3,}/g, "\n\n");
}

function hasHeading(content: string, heading: string): boolean {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
  return re.test(content);
}

function parseSections(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = content.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) map.set(current, buf.join("\n"));
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) map.set(current, buf.join("\n"));
  return map;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract text between `# Profile` (or start of file) and the first `##` heading. */
function extractPreamble(content: string): string {
  const h1Match = /^#\s+Profile\s*$/.exec(content);
  const start = h1Match ? h1Match.index + h1Match[0].length : 0;
  const rest = content.slice(start);
  const firstH2 = /^##\s+/.exec(rest);
  if (!firstH2) return rest.trim().length > 0 ? rest : "";
  return rest.slice(0, firstH2.index).trim();
}

/** Return all `##` heading titles in document order. */
function parseSectionsWithOrder(content: string): string[] {
  const headings: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) headings.push(m[1]);
  }
  return headings;
}
