// jsdom is ~650ms to load; built lazily on first call so importing kxta-core (MCP stdio startup, web db-init) doesn't pay for it when HTML is never touched.
let purify: ReturnType<typeof import("dompurify").default> | undefined;

async function getPurify() {
  if (purify) return purify;
  const [{ JSDOM }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
  const { window } = new JSDOM("");
  purify = createDOMPurify(window as any);
  const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (!URL_ATTRS.has(data.attrName)) return;
    const v = String(data.attrValue).trim();
    if (data.attrName === "src" && /^data:image\//i.test(v)) return;
    if (/^(javascript|data|vbscript|file):/i.test(v)) data.keepAttr = false;
  });
  return purify;
}

export async function sanitizeHtml(dirty: string): Promise<string> {
  const p = await getPurify();
  return p.sanitize(dirty, {
    WHOLE_DOCUMENT: false,
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  });
}
