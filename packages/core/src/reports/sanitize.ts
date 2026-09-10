// jsdom is ~650ms to load; built lazily on first call so importing kxta-core (MCP stdio startup, web db-init) doesn't pay for it when HTML is never touched.
let purify: ReturnType<typeof import("dompurify").default> | undefined;

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
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
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
    // <style> dropped — CSS is a covert-exfil channel via url()/@import that no DOMPurify hook can safely tighten.
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "style", "link", "meta", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "style"],
  });
}
