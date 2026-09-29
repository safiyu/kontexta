// jsdom is ~650ms to load; built lazily on first call so importing kxta-core (MCP stdio startup, web db-init) doesn't pay for it when HTML is never touched.
let purify: ReturnType<typeof import("dompurify").default> | undefined;

// CSS is kept (reports need layout) but every resource-loading construct is removed so a stylesheet can't beacon or exfil through url()/@import/image-set().
export function scrubCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Decode CSS escapes first so `u\72 l(` / `\75rl(` resolve to `url(` and get caught below.
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => { const cp = parseInt(h, 16); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""; })
    .replace(/\\(.)/g, "$1")
    .replace(/@import\b[^;{]*(;|(?=\}))/gi, "")
    .replace(/@(document|-moz-document)\b[^{]*\{/gi, "@media not all {")
    .replace(/\b(url|image-set|image|src|element|expression)\s*\((?:[^()]|\([^()]*\))*\)/gi, "none")
    .replace(/-moz-binding\s*:[^;}]*;?/gi, "")
    .replace(/\bbehavior\s*:[^;}]*;?/gi, "");
}

async function getPurify() {
  if (purify) return purify;
  const [{ JSDOM }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("");
  purify = createDOMPurify(window as any);
  // Full set of URL-loading attributes DOMPurify might otherwise leave alone — leaving any out lets an attacker load remote resources (tracking, exfil) inside our sandboxed viewer / headless-export.
  const URL_ATTRS = new Set([
    "href", "src", "srcset", "action", "formaction", "xlink:href",
    "poster", "background", "cite", "longdesc", "usemap", "manifest", "codebase",
    "data", "ping", "profile", "archive", "icon",
  ]);
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.textContent = scrubCss(node.textContent ?? "");
  });
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style") { data.attrValue = scrubCss(String(data.attrValue)); return; }
    if (!URL_ATTRS.has(data.attrName)) return;
    const v = String(data.attrValue).trim();
    if (data.attrName === "src" && /^data:image\//i.test(v)) return;
    if (/^(javascript|data|vbscript|file):/i.test(v)) { data.keepAttr = false; return; }
    // srcset / ping / any attr carrying a URL list — reject if any candidate uses a dangerous scheme.
    if (/(?:^|[\s,])\s*(javascript|data|vbscript|file):/i.test(v)) data.keepAttr = false;
  });
  return purify;
}

export async function sanitizeHtml(dirty: string): Promise<string> {
  const p = await getPurify();
  return p.sanitize(dirty, {
    WHOLE_DOCUMENT: false,
    FORCE_BODY: true,
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  });
}
