import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import { listFiles, readFile } from "../src/files/index.js";
import { clipUrl } from "../src/clip/index.js";
import * as extract from "../src/clip/extract.js";
import * as dns from "node:dns/promises";

// Hoist the dns/promises mock so Vitest can intercept it in ESM.
// Individual tests override the mock per-call via vi.mocked(dns.lookup).mockResolvedValueOnce().
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const ARTICLE_HTML = `<!doctype html><html><head><title>T</title></head>
<body><article><h1>H</h1><p>${"body ".repeat(60)}</p></article></body></html>`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kontexta-clip-"));
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  createDatabase(join(dataDir, "test.db"));
});
afterEach(() => {
  vi.restoreAllMocks(); // prevent spy leakage between describe blocks
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("clipUrl", () => {
  it("creates a new file under knowledge/urlclips with frontmatter and source_path set", async () => {
    vi.spyOn(extract, "fetchHtml").mockResolvedValue({ html: ARTICLE_HTML, finalUrl: "https://example.com/a" });
    const file = await clipUrl({ url: "https://example.com/a", dataDir });
    expect(file.path).toContain(`knowledge${sep}urlclips${sep}`);
    expect(file.source_path).toBe("https://example.com/a");
    expect(file.content).toContain("source: https://example.com/a");
    expect(file.content).toContain("# H");
  });

  it("on second clip with identical content, returns existing record without writing", async () => {
    vi.spyOn(extract, "fetchHtml").mockResolvedValue({ html: ARTICLE_HTML, finalUrl: "https://example.com/a" });
    const first = await clipUrl({ url: "https://example.com/a", dataDir });
    const second = await clipUrl({ url: "https://example.com/a", dataDir });
    expect(second.id).toBe(first.id);
    const all = listFiles({ dataDir });
    expect(all.filter((f) => f.source_path === "https://example.com/a")).toHaveLength(1);
  });

  it("on second clip with changed content, updates existing file", async () => {
    const spy = vi.spyOn(extract, "fetchHtml");
    spy.mockResolvedValueOnce({ html: ARTICLE_HTML, finalUrl: "https://example.com/a" });
    const first = await clipUrl({ url: "https://example.com/a", dataDir });

    const newer = ARTICLE_HTML.replace("body ", "updated ");
    spy.mockResolvedValueOnce({ html: newer, finalUrl: "https://example.com/a" });
    const second = await clipUrl({ url: "https://example.com/a", dataDir });

    expect(second.id).toBe(first.id);
    const fresh = readFile(first.id);
    expect(fresh.content).toContain("updated");
  });

  it("uses post-redirect finalUrl for dedup", async () => {
    vi.spyOn(extract, "fetchHtml").mockResolvedValue({ html: ARTICLE_HTML, finalUrl: "https://example.com/canonical" });
    const file = await clipUrl({ url: "https://example.com/redirect", dataDir });
    expect(file.source_path).toBe("https://example.com/canonical");
  });
});

describe("fetchHtml SSRF protection", () => {
  it("rejects hostnames that are obviously private before any network call", async () => {
    // These are caught by string matching before dns.lookup is ever called.
    // We don't need to mock fetch — the check fires synchronously before it.
    const localNames = [
      "http://localhost/admin",
      "http://server.local/page",
      "http://db.internal/api",
      "http://host.lan/",
      "http://foo.localhost/bar",
    ];
    for (const url of localNames) {
      await expect(extract.fetchHtml(url)).rejects.toThrow(extract.ClipError);
      await expect(extract.fetchHtml(url)).rejects.toThrow(/Refusing to clip non-public host/);
    }
  });

  it("rejects literal private IPv4 addresses before any network call", async () => {
    // isIP() identifies these as IPv4 literals — dns.lookup is skipped entirely.
    const privateIPs = [
      "http://127.0.0.1/admin",
      "http://192.168.1.1/router",
      "http://10.0.0.5/api",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/",  // CGNAT
      "http://0.0.0.1/",     // "this" network
    ];
    for (const url of privateIPs) {
      await expect(extract.fetchHtml(url)).rejects.toThrow(extract.ClipError);
      await expect(extract.fetchHtml(url)).rejects.toThrow(/Refusing to clip private\/loopback IPv4/);
    }
  });

  it("rejects literal private IPv6 addresses before any network call", async () => {
    const privateIPv6 = [
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
    ];
    for (const url of privateIPv6) {
      await expect(extract.fetchHtml(url)).rejects.toThrow(extract.ClipError);
      await expect(extract.fetchHtml(url)).rejects.toThrow(/Refusing to clip private\/loopback IPv6/);
    }
  });

  it("rejects a public hostname that resolves to a private IP (DNS rebinding)", async () => {
    // This tests the post-DNS-resolution check: a public-looking host that
    // resolves to 10.0.0.5. vi.mock('node:dns/promises') is hoisted at the top
    // of the file so Vitest can intercept the ESM module binding.
    vi.mocked(dns.lookup).mockResolvedValueOnce(
      [{ address: "10.0.0.5", family: 4 }] as any
    );
    await expect(
      extract.fetchHtml("http://evil.example.com/")
    ).rejects.toThrow(/Host evil\.example\.com resolves to private IPv4 10\.0\.0\.5/);
  });
});
