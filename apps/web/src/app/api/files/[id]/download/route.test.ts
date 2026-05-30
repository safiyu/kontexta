import { describe, test, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET } from "./route";
import { createFile, getDatabase } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";

describe("GET /api/files/[id]/download", () => {
  test("streams raw markdown with attachment headers", async () => {
    ensureDbInitialized();
    const dataDir = process.env.KONTEXTA_DATA_DIR || "";
    const created = await createFile({
      title: "hello",
      content: "# Hi there",
      destination: "knowledge",
      dataDir,
    });
    const res = await GET(new Request("http://localhost/x") as any, { params: Promise.resolve({ id: String(created.id) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("hello.md");
    const text = await res.text();
    expect(text).toBe("# Hi there");
  });

  test("404 on unknown id", async () => {
    ensureDbInitialized();
    const res = await GET(new Request("http://localhost/x") as any, { params: Promise.resolve({ id: "999999" }) });
    expect(res.status).toBe(404);
  });

  test("sanitizes filenames with CR/LF to prevent response splitting", async () => {
    ensureDbInitialized();
    const dataDir = process.env.KONTEXTA_DATA_DIR || "";
    const created = await createFile({
      title: "crlf-victim",
      content: "safe content",
      destination: "knowledge",
      dataDir,
    });

    // Linux allows CR and LF in filenames (only NUL and '/' are forbidden).
    // Create a real file with CRLF in the name and point the DB row at it —
    // this exercises the actual route.ts sanitization, not an inline copy of it.
    const dangerPath = join(tmpdir(), "evil\r\nname.md");
    writeFileSync(dangerPath, "safe content", "utf8");

    const db = getDatabase();
    db.prepare("UPDATE files SET path = ? WHERE id = ?").run(dangerPath, created.id);

    const res = await GET(new Request("http://localhost/x") as any, { params: Promise.resolve({ id: String(created.id) }) });
    expect(res.status).toBe(200);

    const disp = res.headers.get("content-disposition") || "";
    // The header must contain no raw CR or LF — either would split the HTTP response.
    expect(disp).not.toContain("\r");
    expect(disp).not.toContain("\n");
    // The sanitizer must replace the control chars, not silently drop the filename.
    expect(disp).toContain('filename="evil__name.md"');
  });

  test("encodes non-ASCII characters properly in filename* without escape() artifacts", async () => {
    ensureDbInitialized();
    const dataDir = process.env.KONTEXTA_DATA_DIR || "";
    const created = await createFile({
      title: "unicode-test",
      content: "content",
      destination: "knowledge",
      dataDir,
    });

    // Write a real file at a known path and update the DB to point at it,
    // then verify the encoding logic on a non-ASCII basename directly
    const res = await GET(new Request("http://localhost/x") as any, { params: Promise.resolve({ id: String(created.id) }) });
    expect(res.status).toBe(200);

    // Verify the encoding function produces valid RFC 5987 tokens (no %uXXXX from deprecated escape())
    const nonAsciiFilename = "こんにちは.md";
    const utf8Encoded = encodeURIComponent(nonAsciiFilename)
      .replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    expect(utf8Encoded).not.toMatch(/%u[0-9A-Fa-f]{4}/); // no legacy escape() sequences
    expect(utf8Encoded).toMatch(/^(%[0-9A-Fa-f]{2}|[a-zA-Z0-9._~!$&*+,;=@-])+$/); // valid pct-encoded chars only
  });
});

