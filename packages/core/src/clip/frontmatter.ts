import { computeHash } from "../files/index.js";

export interface FrontmatterFields {
  source: string;
  title: string;
  clippedAt: string;
  body: string;
}

// YAML 1.2 indicators that, when they appear as the first non-space char of
// a plain scalar, change its meaning (flow sequences, mappings, anchors,
// aliases, tags, block scalars, comments, directives, reserved). See:
// https://yaml.org/spec/1.2.2/#flow-scalar-styles
const YAML_LEADING_INDICATORS = new Set([
  "-", "?", ":", ",", "[", "]", "{", "}", "&", "*", "!", "|", ">", "%", "@", "`",
]);

function yamlScalar(value: string): string {
  // Quote when the value can be misparsed as YAML structure:
  //  - empty (would parse as null)
  //  - leading whitespace or leading YAML indicator chars
  //  - embedded "key: " or trailing colon (flow-style mapping confusion)
  //  - anything with newline, quote, hash (comment), or non-trim whitespace
  //  - tokens that look like booleans, null, or numbers (would be re-typed
  //    on parse — `title: yes` becomes `title: true`)
  const needsQuote =
    value.length === 0 ||
    YAML_LEADING_INDICATORS.has(value.charAt(0)) ||
    /^\s/.test(value) ||
    /: /.test(value) ||
    /:\n/.test(value) ||
    /[#\n"']/.test(value) ||
    value.trim() !== value ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(value) ||
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);

  if (needsQuote) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function buildFrontmatter(f: FrontmatterFields): string {
  return [
    "---",
    `source: ${yamlScalar(f.source)}`,
    `title: ${yamlScalar(f.title)}`,
    `clipped_at: ${yamlScalar(f.clippedAt)}`,
    "---",
    "",
    f.body,
  ].join("\n");
}

export function splitFrontmatter(file: string): string {
  if (!file.startsWith("---\n")) return file;
  const end = file.indexOf("\n---\n", 4);
  if (end === -1) return file;
  return file.slice(end + 5).replace(/^\n+/, "");
}

export function hashBody(file: string): string {
  return computeHash(splitFrontmatter(file));
}
