/** Publish configuration (from docs.config.json ⊕ CLI flags). */
export interface SourceConfig {
  /** Vault folders to render; each becomes a top-level sidebar group. */
  folders: string[];
}
export interface SiteConfig {
  title: string;
  brand: string;
  logo?: string;
  hero: boolean;
}
export interface PublishConfig {
  source: SourceConfig;
  site: SiteConfig;
  /** Output file path, resolved relative to cwd. */
  output: string;
}

/** Frontmatter we read from each doc (all optional). */
export interface Frontmatter {
  title?: string;
  group?: string;
  order?: number;
  icon?: string;
}

/** One markdown doc pulled from the vault. */
export interface DocFile {
  id: number;
  folder: string;     // top-level group key
  path: string;       // absolute vault path
  slug: string;       // route slug, unique within folder
  frontmatter: Frontmatter;
  body: string;       // markdown with frontmatter stripped
  title: string;      // resolved: frontmatter.title ?? first H1 ?? file title
}

export interface TocEntry { level: number; text: string; id: string; }

export interface EndpointData {
  id: string;
  method: string;
  path: string;
  description?: string;
  badge?: "direct" | "remove" | "evolve";
  headers?: Record<string, string>;
  statusCodes?: Record<string, string>;
  request?: string;
  response?: string;
}

export interface GlossaryTerm { term: string; definition: string; }

export interface RenderedDoc {
  doc: DocFile;
  html: string;
  toc: TocEntry[];
  endpoints: EndpointData[];
  terms?: GlossaryTerm[];  // glossary terms collected during render (optional — only set when glossary blocks exist)
}

export interface NavItem { title: string; slug: string; folder: string; icon?: string; }
export interface NavGroup { group: string; items: NavItem[]; }

export type SearchType = "page" | "heading" | "endpoint" | "term";
export interface SearchEntry {
  title: string;
  group: string;
  type: SearchType;
  url: string;     // hash route, e.g. "#/slt/api" or "#/slt/api#auth"
  text: string;    // searchable text
}

/** markdown-it render env: block rules push collected data here. */
export interface RenderEnv {
  endpoints: EndpointData[];
}
