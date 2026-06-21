import yaml from "js-yaml";
import { slugify } from "kxta-core";
import type { GlossaryTerm, RenderEnv } from "../../types.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderGlossary(body: string, env?: RenderEnv): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch (e) {
    throw new Error(`Invalid YAML in glossary block: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("glossary block must be a YAML list of {term, definition}");
  }
  const seen = new Set<string>();
  const terms: GlossaryTerm[] = (parsed as GlossaryTerm[]).map((t) => {
    const term = String(t.term ?? "");
    const definition = String(t.definition ?? "");
    let id = slugify(term).toLowerCase() || "term";
    let n = 2;
    while (seen.has(id)) id = `${slugify(term).toLowerCase() || "term"}-${n++}`;
    seen.add(id);
    return { id, term, definition };
  });
  if (env) {
    env.terms = env.terms ?? [];
    env.terms.push(...terms);
  }
  const items = terms.map(
    (t) => `<div class="glossary-item" id="${t.id}">
  <div class="glossary-term">${escapeHtml(t.term)}</div>
  <div class="glossary-def">${escapeHtml(t.definition)}</div>
</div>`,
  );
  return `<div class="glossary-grid">${items.join("\n")}</div>`;
}
