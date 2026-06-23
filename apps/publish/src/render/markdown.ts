import MarkdownIt from "markdown-it";
import { slugify } from "kxta-core";
import { renderMermaid } from "./blocks/mermaid.js";
import { renderEndpoints } from "./blocks/endpoints.js";
import { renderGlossary } from "./blocks/glossary.js";
import type { RenderEnv, EndpointData, GlossaryTerm } from "../types.js";

/**
 * Create a markdown-it instance pre-configured with:
 * - heading_open rule that injects slugified `id` attributes
 * - fence rule that routes `mermaid`, `endpoints`, `glossary` fenced
 *   blocks to their special transformers while leaving ordinary fences
 *   as normal code blocks.
 */
export function createMarkdown(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

  // Inject slugified ids into headings, deduplicated within the document so
  // repeated headings (e.g. two "## Setup" sections) get distinct anchors.
  md.core.ruler.push("heading-id", (state) => {
    const seen = new Set<string>();
    for (let idx = 0; idx < state.tokens.length; idx++) {
      const tok = state.tokens[idx];
      if (tok.type !== "heading_open") continue;
      const level = Number(tok.tag.replace("h", ""));
      let text = "";
      for (let i = idx + 1; i < state.tokens.length; i++) {
        if (state.tokens[i].type === "heading_close") break;
        if (state.tokens[i].content) text += state.tokens[i].content;
      }
      const base = slugify(text).toLowerCase() || `h${level}`;
      let id = base;
      let n = 2;
      while (seen.has(id)) id = `${base}-${n++}`;
      seen.add(id);
      tok.attrSet("id", id);
      tok.attrSet("data-heading-level", String(level));
    }
    return false;
  });

  // Route fenced blocks
  md.renderer.rules.fence = (tokens, idx, options, env: RenderEnv, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0] ?? "";
    const body = token.content;

    if (lang === "mermaid") return renderMermaid(body, token.attrGet("id") || "m" + idx);
    if (lang === "endpoints") return renderEndpoints(body, env.endpoints);
    if (lang === "glossary") return renderGlossary(body, env);

    // Default: normal code block
    const langName = lang || options.langPrefix || "";
    const code = escapeHtml(body);
    return `<pre><code class="language-${escapeHtml(langName)}">${code}</code></pre>\n`;
  };

  return md;
}

/**
 * Convenience wrapper: render markdown body → { html, toc, endpoints }.
 * Uses a fresh markdown-it instance and collects TOC from heading ids.
 */
export function renderDocBody(content: string): {
  html: string;
  toc: { id: string; text: string; level: number }[];
  endpoints: EndpointData[];
  terms: GlossaryTerm[];
} {
  const md = createMarkdown();
  const env: RenderEnv = { endpoints: [] };
  const html = md.render(content, env);

  // Extract TOC from heading ids in the rendered HTML
  const toc: { id: string; text: string; level: number }[] = [];
  const headingRe = /<h(\d)[^>]*id="([^"]+)"[^>]*>(.*?)<\/h\d>/g;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    toc.push({
      level: Number(m[1]),
      id: m[2],
      text: m[3].replace(/<[^>]+>/g, "").trim(),
    });
  }

  return { html, toc, endpoints: env.endpoints, terms: env.terms ?? [] };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
