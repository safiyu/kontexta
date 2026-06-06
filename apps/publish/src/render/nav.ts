import type {
  DocFile,
  NavGroup,
  NavItem,
  RenderedDoc,
  SearchEntry,
} from "../types.js";

/**
 * Build a navigation tree grouped by folder.
 *
 * Within each group items are sorted by:
 * 1. `frontmatter.order` (ascending, missing → Infinity)
 * 2. `slug` (ascending)
 *
 * The group label can be overridden via `frontmatter.group`.
 */
export function buildNav(docs: RenderedDoc[]): NavGroup[] {
  const groups = new Map<string, RenderedDoc[]>();

  for (const r of docs) {
    const folder = r.doc.folder;
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(r);
  }

  const result: NavGroup[] = [];
  for (const [folder, items] of groups) {
    items.sort((a, b) => {
      const orderA = a.doc.frontmatter.order ?? Infinity;
      const orderB = b.doc.frontmatter.order ?? Infinity;
      if (orderA !== orderB) return orderA - orderB;
      return a.doc.slug.localeCompare(b.doc.slug);
    });

    const groupLabel = items[0]?.doc.frontmatter.group ?? folder;

    result.push({
      group: groupLabel,
      items: items.map((r) => ({
        title: r.doc.title,
        slug: r.doc.slug,
        folder: r.doc.folder,
        path: r.doc.path,
      })),
    });
  }

  return result;
}

/**
 * Build a flat search index from rendered docs.
 *
 * Emits entries of type:
 * - `page` — one per doc (full-page match)
 * - `heading` — one per TOC entry with hash route
 * - `endpoint` — one per endpoint with hash route
 * - `term` — one per glossary term with hash route
 */
export function buildSearchIndex(docs: RenderedDoc[]): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const r of docs) {
    const base = `/${r.doc.folder}/${r.doc.slug}`;

    // Page entry
    entries.push({
      type: "page",
      title: r.doc.title,
      folder: r.doc.folder,
      slug: r.doc.slug,
      url: `#${base}`,
      snippet: r.doc.body.slice(0, 200),
    });

    // Heading entries
    for (const h of r.toc) {
      entries.push({
        type: "heading",
        title: h.text,
        folder: r.doc.folder,
        slug: r.doc.slug,
        url: `#${base}#${h.id}`,
        snippet: "",
      });
    }

    // Endpoint entries
    for (const ep of r.endpoints) {
      entries.push({
        type: "endpoint",
        title: `${ep.method} ${ep.path}`,
        folder: r.doc.folder,
        slug: r.doc.slug,
        url: `#${base}#${ep.id}`,
        snippet: ep.description ?? "",
      });
    }

    // Glossary term entries
    for (const term of r.terms ?? []) {
      entries.push({
        type: "term",
        title: term.term,
        folder: r.doc.folder,
        slug: r.doc.slug,
        url: `#${base}#${term.id}`,
        snippet: term.definition,
      });
    }
  }

  return entries;
}
