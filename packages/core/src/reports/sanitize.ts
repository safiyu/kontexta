import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";

const { window } = new JSDOM("");
const purify = createDOMPurify(window as unknown as Window);

purify.addHook("uponSanitizeAttribute", (_node, data) => {
  const isUrlAttr = data.attrName === "href" || data.attrName === "src" || data.attrName === "action";
  if (!isUrlAttr) return;
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
