import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { assertPathInside } from "../util/safety.js";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

export interface ResourceInfo { filename: string; size: number; url: string; }

const NAME_RE = /^[a-z0-9._-]+$/;

function slugName(input: string): string {
  const ext = extname(input).toLowerCase();
  const base = input.slice(0, input.length - ext.length).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "resource";
  return `${base}${ext || ""}`;
}

function resourcesDirPath(projectRoot: string): string {
  return join(projectRoot, "reports", "resources");
}

export function mimeFor(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export function resourceUrlFor(filename: string): string {
  return `/api/reports/resources/${filename}`;
}

export function writeResource(projectRoot: string, filename: string, bytes: Buffer): ResourceInfo {
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) throw new Error(`path traversal not allowed: ${filename}`);
  const dir = resourcesDirPath(projectRoot);
  mkdirSync(dir, { recursive: true });
  let safe = slugName(filename);
  if (!NAME_RE.test(safe)) throw new Error(`unsafe filename: ${filename}`);
  let target = assertPathInside(dir, safe);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (!existing.equals(bytes)) {
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
      const ext = extname(safe);
      const base = safe.slice(0, safe.length - ext.length);
      safe = `${base}-${hash}${ext}`;
      target = assertPathInside(dir, safe);
    }
  }
  writeFileSync(target, bytes);
  return { filename: safe, size: bytes.length, url: resourceUrlFor(safe) };
}

export function readResource(projectRoot: string, filename: string): { bytes: Buffer; mime: string } {
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) throw new Error(`path traversal not allowed: ${filename}`);
  const dir = resourcesDirPath(projectRoot);
  if (!NAME_RE.test(filename)) throw new Error(`unsafe filename: ${filename}`);
  const target = assertPathInside(dir, filename);
  return { bytes: readFileSync(target), mime: mimeFor(filename) };
}

export function listResources(projectRoot: string): ResourceInfo[] {
  const dir = resourcesDirPath(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => NAME_RE.test(n)).map(n => ({
    filename: n,
    size: statSync(join(dir, n)).size,
    url: resourceUrlFor(n),
  }));
}

export function deleteResource(projectRoot: string, filename: string): void {
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) throw new Error(`path traversal not allowed: ${filename}`);
  const dir = resourcesDirPath(projectRoot);
  if (!NAME_RE.test(filename)) throw new Error(`unsafe filename: ${filename}`);
  const target = assertPathInside(dir, filename);
  if (existsSync(target)) unlinkSync(target);
}
