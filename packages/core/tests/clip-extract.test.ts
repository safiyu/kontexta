import { describe, it, expect, vi, afterEach } from "vitest";
import { extractFromHtml, fetchHtml, ClipError } from "../src/clip/extract.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]),
}));

const ARTICLE_HTML = `
<!doctype html><html><head><title>Sample Page</title></head>
<body>
  <nav>nav junk</nav>
  <article>
    <h1>Real Heading</h1>
    <p>${"This is the actual article body content. ".repeat(20)}</p>
    <pre><code>const x = 1;</code></pre>
  </article>
  <footer>footer junk</footer>
</body></html>`;

describe("extractFromHtml", () => {
  it("returns title and markdown body for an article-shaped page", async () => {
    const r = await extractFromHtml(ARTICLE_HTML, "https://example.com/x");
    expect(r.title).toBe("Sample Page");
    expect(r.markdown).toContain("Real Heading");
    expect(r.markdown).toContain("const x = 1");
    expect(r.markdown).not.toContain("nav junk");
    expect(r.markdown).not.toContain("footer junk");
  });

  it("throws EXTRACTION_FAILED when body is too short", async () => {
    const html = `<!doctype html><html><body><p>tiny</p></body></html>`;
    await expect(extractFromHtml(html, "https://example.com/x")).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
    });
  });

  it("throws AUTH_REQUIRED when short body contains a password input", async () => {
    const html = `<!doctype html><html><body>
      <form action="/login"><input type="password" name="pw"/></form>
    </body></html>`;
    await expect(extractFromHtml(html, "https://wiki.example.com/page")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      details: { signal: "login_page_body", loginUrl: "https://wiki.example.com/page" },
    });
  });

  it("throws AUTH_REQUIRED for Confluence-style os_username form", async () => {
    const html = `<!doctype html><html><body>
      <form action="/login.action"><input name="os_username"/></form>
    </body></html>`;
    await expect(extractFromHtml(html, "https://confluence.example.com/x")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      details: { signal: "login_page_body" },
    });
  });
});

describe("fetchHtml auth detection", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("throws AUTH_REQUIRED on HTTP 401 with WWW-Authenticate header surfaced", async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      return new Response("nope", {
        status: 401,
        headers: { "www-authenticate": "Bearer realm=\"api\"", "content-type": "text/html" },
      }) as any;
    }) as any;
    // Patch res.url which Response doesn't expose by default — wrap.
    const wrap = globalThis.fetch as any;
    globalThis.fetch = (async (input: any) => {
      const r = await wrap(input);
      Object.defineProperty(r, "url", { value: typeof input === "string" ? input : input.url });
      return r;
    }) as any;
    await expect(fetchHtml("https://api.example.com/x")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      details: { signal: "http_401", wwwAuthenticate: 'Bearer realm="api"' },
    });
  });

  it("throws AUTH_REQUIRED on redirect to a /login URL", async () => {
    globalThis.fetch = (async (input: any) => {
      const r = new Response("<html><body>redirected</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(r, "url", { value: "https://example.com/login?redirect_to=/x" });
      return r;
    }) as any;
    await expect(fetchHtml("https://example.com/x")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      details: { signal: "redirect_to_login", loginUrl: "https://example.com/login?redirect_to=/x" },
    });
  });

  it("forwards optional headers (cookies / bearer) to the fetch", async () => {
    const seen: Record<string, string> = {};
    globalThis.fetch = (async (input: any, init: any) => {
      const h = new Headers(init?.headers);
      h.forEach((v, k) => { seen[k.toLowerCase()] = v; });
      const r = new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(r, "url", { value: typeof input === "string" ? input : input.url });
      return r;
    }) as any;
    await fetchHtml("https://example.com/x", { headers: { Cookie: "session=abc", Authorization: "Bearer xyz" } });
    expect(seen.cookie).toBe("session=abc");
    expect(seen.authorization).toBe("Bearer xyz");
  });

  it("throws ClipError(INVALID_URL) for unparseable input", async () => {
    await expect(fetchHtml("not a url")).rejects.toMatchObject({ code: "INVALID_URL" });
  });
});
