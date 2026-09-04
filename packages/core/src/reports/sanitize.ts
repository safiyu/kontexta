import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";

const { window } = new JSDOM("");
const purify = createDOMPurify(window as any);

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (!URL_ATTRS.has(data.attrName)) return;
  const v = String(data.attrValue).trim();
  if (data.attrName === "src" && /^data:image\//i.test(v)) return;
  if (/^(javascript|data|vbscript|file):/i.test(v)) data.keepAttr = false;
});

export function sanitizeHtml(dirty: string): string {
  return purify.sanitize(dirty, {
    WHOLE_DOCUMENT: false,
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  });
}
