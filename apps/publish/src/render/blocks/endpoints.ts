import yaml from "js-yaml";
import type { EndpointData } from "../../types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function endpointId(method: string, path: string): string {
  return `${method}-${path}`
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Render an `endpoints` block: cards (click-to-open via app.js modal) and push
 * full EndpointData into `collected` for the modal dataset.
 */
export function renderEndpoints(body: string, collected: EndpointData[]): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch (e) {
    throw new Error(`Invalid YAML in endpoints block: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("endpoints block must be a YAML list of endpoint objects");
  }
  const cards: string[] = [];
  for (const raw of parsed as Record<string, unknown>[]) {
    const method = String(raw.method ?? "GET").toUpperCase();
    const path = String(raw.path ?? "");
    const id = endpointId(method, path);
    const ep: EndpointData = {
      id,
      method,
      path,
      description: raw.description as string | undefined,
      badge: raw.badge as EndpointData["badge"],
      headers: raw.headers as Record<string, string> | undefined,
      statusCodes: raw.statusCodes as Record<string, string> | undefined,
      request: raw.request as string | undefined,
      response: raw.response as string | undefined,
    };
    collected.push(ep);
    const badge = ep.badge
      ? `<span class="api-badge-${ep.badge}">${ep.badge}</span>`
      : "";
    cards.push(`<div class="api-endpoint" data-endpoint-id="${id}" onclick="openEndpoint('${id}')">
  <div class="api-endpoint-header">
    <span class="api-method">${method}</span>
    <span class="api-path">${escapeHtml(path)}</span>
    ${badge}
  </div>
  ${ep.description ? `<div class="api-desc">${escapeHtml(ep.description)}</div>` : ""}
</div>`);
  }
  return `<div class="api-endpoints">${cards.join("\n")}</div>`;
}
