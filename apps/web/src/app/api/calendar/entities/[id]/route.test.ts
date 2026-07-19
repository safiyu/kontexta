import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";
import { createEntity, linkEntities, createEvent } from "kxta-core";

describe("calendar entities/[id] API route", () => {
  it("GET returns 404 for an unknown entity", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "999999" }) });
    expect(res.status).toBe(404);
  });

  it("GET returns 400 for a non-numeric id", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(400);
  });

  it("PUT retires an entity (active:false)", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "retire-me" });
    const res = await PUT(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
      { params: Promise.resolve({ id: String(entity.id) }) }
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.active).toBe(false);
  });

  it("DELETE cascades events and links, reporting counts", async () => {
    ensureDbInitialized();
    const a = createEntity({ name: "cascade-a" });
    const b = createEntity({ name: "cascade-b" });
    linkEntities(a.id, b.id, "feeds");
    createEvent({ entity_id: a.id, type: "downtime", title: "e1", starts_at: "2026-08-01T00:00:00Z", ends_at: "2026-08-01T01:00:00Z" });

    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(a.id) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted_events: 1, deleted_links: 1 });
  });

  it("DELETE returns 404 for an unknown entity", async () => {
    ensureDbInitialized();
    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: "999999" }),
    });
    expect(res.status).toBe(404);
  });
});
