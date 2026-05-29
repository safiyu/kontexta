/**
 * Markdown section parsing for the section-level MCP tools.
 *
 * Lightweight regex-based parser — the codebase has no markdown AST
 * dependency and the rules we need are small. Tracks fenced code blocks
 * so `# foo` inside ``` fences isn't mistaken for a heading.
 */

export interface OutlineNode {
  /** Heading level 1-6 (the count of leading '#'). */
  level: number;
  /** Heading text with surrounding whitespace trimmed. */
  text: string;
  /** 1-based line number of the heading line. */
  line: number;
  /** Byte offset of the heading line's first character. */
  byteStart: number;
  /** Byte offset just past the section's body (start of next sibling/parent or EOF). */
  byteEnd: number;
  /** Byte offset where the body content starts (line after the heading). */
  contentStart: number;
  /** Same as `byteEnd` — body ends where the section ends. */
  contentEnd: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^(```|~~~)/;

/**
 * Parse a markdown document into a flat list of headings + their byte ranges.
 * Sections nest implicitly via `level`; the byte range of a section runs from
 * the heading line up to (but not including) the next heading whose level
 * is ≤ this one's, or EOF.
 */
export function parseOutline(content: string): OutlineNode[] {
  const lines = content.split("\n");
  const nodes: OutlineNode[] = [];

  // Track the byte offset of the start of each line. `+ 1` accounts for the
  // newline we split on (the final line has no trailing newline; that's fine
  // because we only ever index into existing line starts).
  const lineStarts: number[] = new Array(lines.length);
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = cursor;
    cursor += Buffer.byteLength(lines[i], "utf8") + 1;
  }
  const totalBytes = Buffer.byteLength(content, "utf8");

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = HEADING_RE.exec(line);
    if (!m) continue;

    const level = m[1].length;
    const text = m[2].trim();
    const byteStart = lineStarts[i];
    const headingLineBytes = Buffer.byteLength(line, "utf8") + 1; // include trailing \n
    const contentStart = Math.min(byteStart + headingLineBytes, totalBytes);

    nodes.push({
      level,
      text,
      line: i + 1,
      byteStart,
      byteEnd: totalBytes, // patched below once we know the next sibling/parent
      contentStart,
      contentEnd: totalBytes,
    });
  }

  // Walk the headings in order; each section ends where the NEXT heading of
  // equal-or-lower level (i.e. same or shallower) starts. This matches the
  // intuitive "## A then ### A.1 then ## B" → A's section runs to B.
  for (let i = 0; i < nodes.length; i++) {
    const me = nodes[i];
    let end = totalBytes;
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j].level <= me.level) {
        end = nodes[j].byteStart;
        break;
      }
    }
    me.byteEnd = end;
    me.contentEnd = end;
  }

  return nodes;
}

/**
 * Find a section by heading text (case-insensitive, whitespace-trimmed).
 * If multiple headings match, prefer the one with the lowest (shallowest)
 * level — typically what an agent saying "Installation" means.
 */
export function findSection(content: string, heading: string): OutlineNode | null {
  const target = heading.trim().toLowerCase();
  const outline = parseOutline(content);
  const matches = outline.filter((n) => n.text.toLowerCase() === target);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.level - b.level || a.line - b.line);
  return matches[0];
}

/**
 * Replace the BODY of a section, preserving the heading line itself. Body
 * is everything from the line after the heading up to (but not including)
 * the next sibling/parent heading.
 *
 * `newBody` is inserted verbatim and is sandwiched in newlines so it lands
 * on its own lines and doesn't fuse with the surrounding text. A trailing
 * newline is added if the body didn't end with one, so the next section
 * still starts on a fresh line.
 */
export function replaceSection(content: string, heading: string, newBody: string): string {
  const node = findSection(content, heading);
  if (!node) {
    throw new Error(`Section not found: ${heading}`);
  }

  const buf = Buffer.from(content, "utf8");
  const before = buf.subarray(0, node.contentStart).toString("utf8");
  const after = buf.subarray(node.contentEnd).toString("utf8");

  // Ensure the new body is properly terminated so the next section header
  // isn't pulled up onto the last line of the new body.
  let body = newBody;
  if (body.length > 0 && !body.endsWith("\n")) body += "\n";

  return before + body + after;
}
