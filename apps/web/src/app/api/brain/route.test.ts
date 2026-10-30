import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "./route";
import { POST as SHARE } from "./share/route";
import { ensureDbInitialized } from "@/lib/db-init";

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function stubBrainHost(created: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok", service: "kontexta-relay" }), { status: 200 });
      if (url.endsWith("/brains/join")) {
        return new Response(JSON.stringify({ brain_id: 1, name: "Web Brain", created, token: "t".repeat(64), latest_seq: 0 }), { status: created ? 201 : 200 });
      }
      if (url.includes("/brains/snapshot")) return new Response(JSON.stringify({ gids: [], next: null, latest_seq: 0 }), { status: 200 });
      if (url.endsWith("/brains/me")) return new Response(JSON.stringify({ brain_id: 1, name: "Web Brain", latest_seq: 0, machines: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
}

describe("brain API route", () => {
  it("GET returns the disconnected shape when no brain is joined", async () => {
    ensureDbInitialized();
    await DELETE(new NextRequest("http://localhost/api/brain", { method: "DELETE" }));
    const body = await (await GET(new NextRequest("http://localhost/api/brain"))).json();
    expect(body.connected).toBe(false);
    expect(body.machines).toBeNull();
    expect(typeof body.pending).toBe("number");
  });

  it("POST requires a url and either a share id or create", async () => {
    ensureDbInitialized();
    expect((await POST(new NextRequest("http://localhost/api/brain", json({})))).status).toBe(400);
    expect((await POST(new NextRequest("http://localhost/api/brain", json({ url: "https://h.test" })))).status).toBe(400);
  });

  it("POST with create=true joins, returns the share id once, and GET then masks it", async () => {
    ensureDbInitialized();
    stubBrainHost(true);
    const res = await POST(new NextRequest("http://localhost/api/brain", json({ url: "https://h.test", create: true, name: "Web Brain", enrollSecret: "s" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ connected: true, created: true, name: "Web Brain" });
    expect(body.shareId).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);

    const status = await (await GET(new NextRequest("http://localhost/api/brain"))).json();
    expect(status.connected).toBe(true);
    expect(status.shareId).toBe(`${body.shareId.slice(0, 4)}-...-${body.shareId.slice(-4)}`);
    expect(JSON.stringify(status)).not.toContain(body.shareId);

    await DELETE(new NextRequest("http://localhost/api/brain", { method: "DELETE" }));
  });

  it("share reveals the kept share id without a password when no master password is configured", async () => {
    ensureDbInitialized();
    stubBrainHost(true);
    const created = await (await POST(new NextRequest("http://localhost/api/brain", json({ url: "https://h.test", create: true, enrollSecret: "s" })))).json();
    const res = await SHARE(new NextRequest("http://localhost/api/brain/share", json({})));
    expect(res.status).toBe(200);
    expect((await res.json()).shareId).toBe(created.shareId);
    await DELETE(new NextRequest("http://localhost/api/brain", { method: "DELETE" }));
  });
});
