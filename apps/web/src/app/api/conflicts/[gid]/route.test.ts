import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GET, POST } from "./route";
import { ensureDbInitialized, DATA_DIR } from "@/lib/db-init";
import { registerConflict, getConflict, pendingCount, getDatabase } from "kxta-core";

function makeConflictFile(name: string, local: string): string {
  const p = join(DATA_DIR, "knowledge", name);
  mkdirSync(join(DATA_DIR, "knowledge"), { recursive: true });
  writeFileSync(p, local, "utf8");
  return p;
}

function gidFor(i: number): string {
  return `${i}@${"a".repeat(16)}`;
}

function gidParams(gid: string): { params: Promise<{ gid: string }> } {
  return { params: Promise.resolve({ gid: encodeURIComponent(gid) }) };
}

function postBody(obj: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

describe("conflicts/[gid] API route", () => {
  it("GET returns the conflict with diff and both snapshots", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-a.md", "local line\n");
    const gid = gidFor(20);
    registerConflict({
      gid,
      filePath: fp,
      origin: "b".repeat(16),
      originLabel: "laptop-b",
      remoteContent: "remote line\n",
    });

    const res = await GET(new NextRequest("http://localhost/x"), gidParams(gid));
    expect(res.status).toBe(200);
    const c = await res.json();
    expect(c.gid).toBe(gid);
    expect(c.status).toBe("unresolved");
    expect(c.local_content).toBe("local line\n");
    expect(c.remote_content).toBe("remote line\n");
    expect(typeof c.diff).toBe("string");
    expect(c.additions).toBeGreaterThanOrEqual(1);
    expect(c.deletions).toBeGreaterThanOrEqual(1);
  });

  it("GET returns 404 for an unknown gid", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/x"), gidParams(gidFor(999)));
    expect(res.status).toBe(404);
  });

  it("POST keep-server overwrites the canonical file and deletes the copy", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-b.md", "local-b");
    const gid = gidFor(21);
    const rec = registerConflict({
      gid,
      filePath: fp,
      origin: "c".repeat(16),
      originLabel: "laptop-c",
      remoteContent: "remote-b",
    });
    const copy = rec.conflict_path;
    expect(existsSync(copy)).toBe(true);

    const res = await POST(new NextRequest("http://localhost/x", postBody({ strategy: "keep-server" })), gidParams(gid));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(out.strategy).toBe("keep-server");

    // Canonical now holds remote content; conflict copy removed.
    expect(readFileSync(fp, "utf8")).toBe("remote-b");
    expect(existsSync(copy)).toBe(false);

    // keep-server is a sync event too: it enqueues an update so other machines converge.
    expect(typeof out.outboxOpId).toBe("number");

    // Conflict is now resolved.
    const after = getConflict(gid);
    expect(after?.status).toBe("resolved");
    expect(after?.resolution).toBe("keep-server");
  });

  it("POST keep-mine re-asserts local content and enqueues an op", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-c.md", "local-c");
    const gid = gidFor(22);
    const rec = registerConflict({
      gid,
      filePath: fp,
      origin: "d".repeat(16),
      remoteContent: "remote-c",
    });
    const before = pendingCount(getDatabase());

    const res = await POST(new NextRequest("http://localhost/x", postBody({ strategy: "keep-mine" })), gidParams(gid));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(typeof out.outboxOpId).toBe("number");
    expect(pendingCount(getDatabase())).toBe(before + 1);

    // Canonical retains local content; copy removed.
    expect(readFileSync(fp, "utf8")).toBe("local-c");
    expect(existsSync(rec.conflict_path)).toBe(false);
  });

  it("POST keep-both keeps both files and registers the copy as a new tracked file", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-d.md", "local-d");
    const gid = gidFor(23);
    const rec = registerConflict({
      gid,
      filePath: fp,
      origin: "e".repeat(16),
      originLabel: "laptop-e",
      remoteContent: "remote-d",
    });

    const res = await POST(new NextRequest("http://localhost/x", postBody({ strategy: "keep-both" })), gidParams(gid));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(out.newFileGid).toBeTruthy();

    // Both files exist on disk.
    expect(readFileSync(fp, "utf8")).toBe("local-d");
    expect(readFileSync(rec.conflict_path, "utf8")).toBe("remote-d");
  });

  it("POST merged applies the merged text and enqueues an op", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-e.md", "local-e");
    const gid = gidFor(24);
    const rec = registerConflict({
      gid,
      filePath: fp,
      origin: "f".repeat(16),
      remoteContent: "remote-e",
    });
    const merged = "merged-e\nboth kept";

    const res = await POST(
      new NextRequest("http://localhost/x", postBody({ strategy: "merged", mergedContent: merged })),
      gidParams(gid)
    );
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(typeof out.outboxOpId).toBe("number");
    expect(readFileSync(fp, "utf8")).toBe(merged);
    expect(existsSync(rec.conflict_path)).toBe(false);
  });

  it("POST merged without mergedContent returns 400", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-f.md", "local-f");
    const gid = gidFor(25);
    registerConflict({
      gid,
      filePath: fp,
      origin: "0".repeat(16),
      remoteContent: "remote-f",
    });

    const res = await POST(new NextRequest("http://localhost/x", postBody({ strategy: "merged" })), gidParams(gid));
    expect(res.status).toBe(400);
  });

  it("POST with an invalid strategy returns 400", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-g.md", "local-g");
    const gid = gidFor(26);
    registerConflict({
      gid,
      filePath: fp,
      origin: "1".repeat(16),
      remoteContent: "remote-g",
    });

    const res = await POST(new NextRequest("http://localhost/x", postBody({ strategy: "wipe" })), gidParams(gid));
    expect(res.status).toBe(400);
  });

  it("POST returns 409 when the conflict is already resolved", async () => {
    ensureDbInitialized();
    const fp = makeConflictFile("d-h.md", "local-h");
    const gid = gidFor(27);
    registerConflict({
      gid,
      filePath: fp,
      origin: "2".repeat(16),
      remoteContent: "remote-h",
    });

    // Resolve once.
    const first = await POST(
      new NextRequest("http://localhost/x", postBody({ strategy: "keep-server" })),
      gidParams(gid)
    );
    expect(first.status).toBe(200);

    // Second resolve of the same gid -> 409 (no unresolved conflict left).
    const second = await POST(
      new NextRequest("http://localhost/x", postBody({ strategy: "keep-server" })),
      gidParams(gid)
    );
    expect(second.status).toBe(409);
  });
});
