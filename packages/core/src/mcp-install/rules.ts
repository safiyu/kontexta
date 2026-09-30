import type { McpApproval } from "../hooks/registry.js";
import type { McpTool } from "./types.js";

// The tools an approval level covers: null = leave approvals alone, "*" = everything, else an explicit list.
export function approvedTools(approval: McpApproval, tools: readonly McpTool[]): "*" | string[] | null {
  if (approval === "prompt") return null;
  if (approval === "all") return "*";
  return tools.filter((t) => !t.destructive).map((t) => t.name);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

// Rewrites a list of allow rules so the kxta ones equal `desired`, never touching anyone else's. Returns null when nothing should change.
export function rewriteRules(existing: string[], isOurs: (rule: string) => boolean, desired: string[] | null, previous: McpApproval): string[] | null {
  const ours = existing.filter(isOurs);
  if (desired === null) return previous === "prompt" || ours.length === 0 ? null : existing.filter((r) => !isOurs(r));
  if (sameSet(ours, desired)) return null;
  return [...existing.filter((r) => !isOurs(r)), ...desired];
}
