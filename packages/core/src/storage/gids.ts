import { getDatabase } from "../db/index.js";

/** The gid of a projects / calendar_entities row, for op payloads that must not carry machine-local ids. */
export function gidOfRow(table: "projects" | "calendar_entities", id: number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const row = getDatabase().prepare(`SELECT gid FROM ${table} WHERE id = ?`).get(id) as
    | { gid: string | null }
    | undefined;
  return row?.gid ?? null;
}
