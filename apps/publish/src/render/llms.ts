import type { RenderedDoc, SearchEntry } from "../types.js";

/** Generate an llms.txt file for LLM-readable documentation. */
export function generateLlmsTxt(docs: RenderedDoc[], search: SearchEntry[], siteTitle: string): string {
  const lines: string[] = [
    `# ${siteTitle} - LLM-Readable Documentation`,
    ``,
    `This documentation is optimized for both human readers and LLM agents.`,
    ``,
    `## All Documentation`,
  ];

  // List all docs with brief descriptions
  for (const doc of docs) {
    const title = doc.doc.title;
    const slug = doc.doc.slug;
    const folder = doc.doc.folder;
    const desc = extractDescription(doc.html);
    lines.push(`- [${title}](#/${folder}/${slug}) - ${desc}`);
  }

  lines.push("");
  lines.push("## Endpoints");
  for (const entry of search) {
    if (entry.type === "endpoint") {
      lines.push(`- [${entry.title}](${entry.url}) - ${entry.snippet}`);
    }
  }

  lines.push("");
  lines.push("## Glossary Terms");
  for (const entry of search) {
    if (entry.type === "term") {
      lines.push(`- [${entry.title}](${entry.url}) - ${entry.snippet}`);
    }
  }

  return lines.join("\n");
}

/** Extract a plain-text description from HTML content. */
function extractDescription(html: string): string {
  // Strip HTML tags and get first ~200 characters
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? text.slice(0, 200) + "..." : text;
}
