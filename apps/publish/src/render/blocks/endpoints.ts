import yaml from "js-yaml";
import type { EndpointData } from "../../types.js";

const VALID_BADGES = new Set(["direct", "remove", "evolve"]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function endpointId(method: string, path: string): string {
  return `${method}-${path}`
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) { seen.add(base); return base; }
  let n = 2;
  while (seen.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  seen.add(id);
  return id;
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
  const seen = new Set<string>(collected.map((e) => e.id));
  const cards: string[] = [];
  for (const raw of parsed as Record<string, unknown>[]) {
    const rawMethod = String(raw.method ?? "GET").toUpperCase();
    const method = /^[A-Z]+$/.test(rawMethod) ? rawMethod : "GET";
    const path = String(raw.path ?? "");
    const id = uniqueId(endpointId(method, path), seen);
    const rawBadge = raw.badge == null ? undefined : String(raw.badge);
    const badge = rawBadge && VALID_BADGES.has(rawBadge)
      ? (rawBadge as EndpointData["badge"])
      : undefined;
    const ep: EndpointData = {
      id,
      method,
      path,
      description: raw.description as string | undefined,
      badge,
      headers: raw.headers as Record<string, string> | undefined,
      statusCodes: raw.statusCodes as Record<string, string> | undefined,
      request: raw.request as string | undefined,
      response: raw.response as string | undefined,
    };
    collected.push(ep);
    const badgeHtml = badge
      ? `<span class="api-badge-${badge}">${badge}</span>`
      : "";
    cards.push(`<div class="api-endpoint" id="${id}" data-endpoint-id="${id}" onclick="openEndpoint('${id}')">
  <div class="api-endpoint-header">
    <span class="api-method">${escapeHtml(method)}</span>
    <span class="api-path">${escapeHtml(path)}</span>
    ${badgeHtml}
  </div>
  ${ep.description ? `<div class="api-desc">${escapeHtml(ep.description)}</div>` : ""}
</div>`);
  }
  return `<div class="api-endpoints">${cards.join("\n")}</div>`;
}
