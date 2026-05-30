import { getDatabase } from "../db/index.js";

/**
 * Get a setting value by key
 */
export function getSetting(key: string): string | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const row = stmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Set a setting value by key
 */
export function setSetting(key: string, value: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) 
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET 
      value = excluded.value, 
      updated_at = excluded.updated_at
  `);
  stmt.run(key, value);
}

/**
 * Delete a setting by key
 */
export function deleteSetting(key: string): void {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM settings WHERE key = ?");
  stmt.run(key);
}
