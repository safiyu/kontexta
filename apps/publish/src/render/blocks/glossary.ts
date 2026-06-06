import yaml from "js-yaml";
import type { GlossaryTerm } from "../../types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderGlossary(body: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch (e) {
    throw new Error(`Invalid YAML in glossary block: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("glossary block must be a YAML list of {term, definition}");
  }
  const items = (parsed as GlossaryTerm[]).map(
    (t) => `<div class="glossary-item">
  <div class="glossary-term">${escapeHtml(String(t.term ?? ""))}</div>
  <div class="glossary-def">${escapeHtml(String(t.definition ?? ""))}</div>
</div>`,
  );
  return `<div class="glossary-grid">${items.join("\n")}</div>`;
}
