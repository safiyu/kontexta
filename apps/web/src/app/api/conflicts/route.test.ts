import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GET } from "./route";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";
import { registerConflict, resolveConflict } from "kxta-core";

function makeConflictFile(name: string, local: string): string {
  const p = join(DATA_DIR, "knowledge", name);
  mkdirSync(join(DATA_DIR, "knowledge"), { recursive: true });
  writeFileSync(p, local, "utf8");
  return p;
}

function gidFor(i: number): string {
  return `${i}@${"a".repeat(16)}`;
}

describe("conflicts API route (GET /api/conflicts)", () => {
  it("defaults to unresolved conflicts", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("list-a.md", "local-a\nline2");
    registerConflict({
      gid: gidFor(1),
      filePath: fp,
      origin: "b".repeat(16),
      originLabel: "laptop-b",
      remoteContent: "remote-a\nline2",
    });

    const res = await GET(new NextRequest("http://localhost/api/conflicts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.conflicts)).toBe(true);
    const mine = body.conflicts.find((c: any) => c.gid === gidFor(1));
    expect(mine).toBeTruthy();
    expect(mine.status).toBe("unresolved");
    expect(mine.file_path).toBe(fp);
    expect(body.unresolved).toBeGreaterThanOrEqual(1);
    expect(body.count).toBe(body.conflicts.length);
  });

  it("returns empty for status=resolved when none are resolved", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("list-b.md", "local-b");
    registerConflict({
      gid: gidFor(2),
      filePath: fp,
      origin: "c".repeat(16),
      remoteContent: "remote-b",
    });

    const res = await GET(new NextRequest("http://localhost/api/conflicts?status=resolved"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflicts.length).toBe(0);
    expect(body.unresolved).toBeGreaterThanOrEqual(1);
  });

  it("includes a resolved conflict under status=all", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("list-c.md", "local-c");
    const rec = registerConflict({
      gid: gidFor(3),
      filePath: fp,
      origin: "d".repeat(16),
      remoteContent: "remote-c",
    });

    // Resolve it (keep-server) so it flips to resolved.
    const result = await resolveConflict(rec.gid, { strategy: "keep-server" });
    expect(result.success).toBe(true);

    const res = await GET(new NextRequest("http://localhost/api/conflicts?status=all"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const mine = body.conflicts.find((c: any) => c.gid === rec.gid);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe("resolved");
    expect(mine.resolution).toBe("keep-server");

    // And it must NOT appear under the default (unresolved) filter.
    const resDefault = await GET(new NextRequest("http://localhost/api/conflicts"));
    const bodyDefault = await resDefault.json();
    expect(bodyDefault.conflicts.find((c: any) => c.gid === rec.gid)).toBeUndefined();
  });

  it("rejects an invalid status with 400", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/api/conflicts?status=bogus"));
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive limit with 400", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/api/conflicts?limit=0"));
    expect(res.status).toBe(400);
  });

  it("applies limit to the returned list", async () => {
    ensureDbInitialized();
    for (let i = 1; i <= 5; i++) {
      const fp = makeConflictFile(`list-l${i}.md`, `local-${i}`);
      registerConflict({
        gid: gidFor(10 + i),
        filePath: fp,
        origin: "e".repeat(16),
        remoteContent: `remote-${i}`,
      });
    }
    const res = await GET(new NextRequest("http://localhost/api/conflicts?limit=3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflicts.length).toBe(3);
    expect(body.count).toBe(3);
  });
});

