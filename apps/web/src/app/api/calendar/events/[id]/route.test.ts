import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";
import { createEntity, createEvent } from "kxta-core";

describe("calendar events/[id] API route", () => {
  it("PUT moves an event's times", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "move-entity" });
    const event = createEvent({
      entity_id: entity.id, type: "downtime", title: "movable",
      starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z",
    });

    const res = await PUT(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starts_at: "2026-08-02T10:00:00Z", ends_at: "2026-08-02T12:00:00Z" }),
      }),
      { params: Promise.resolve({ id: String(event.id) }) }
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.starts_at).toBe("2026-08-02T10:00:00.000Z");
  });

  it("DELETE removes an event; a second DELETE returns 404", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "delete-entity" });
    const event = createEvent({
      entity_id: entity.id, type: "downtime", title: "to-delete",
      starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z",
    });

    const res1 = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(event.id) }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1).toEqual({ deleted: true });

    const res2 = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(event.id) }),
    });
    expect(res2.status).toBe(404);
  });
});
