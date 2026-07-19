import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";
import { createEntity } from "kxta-core";

describe("calendar events API route", () => {
  it("POST creates a valid event", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "ev-entity-a" });
    const res = await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entity.id, type: "downtime", title: "planned outage",
          starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z",
        }),
      })
    );
    expect(res.status).toBe(201);
    const event = await res.json();
    expect(event.title).toBe("planned outage");
    expect(event.source).toBe("web");
  });

  it("POST rejects a naive timestamp with a friendly message", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "ev-entity-b" });
    const res = await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entity.id, type: "downtime", title: "bad",
          starts_at: "2026-08-01T10:00:00", ends_at: "2026-08-01T12:00:00",
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/naive ISO timestamp/);
  });

  it("POST rejects ends_at <= starts_at", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "ev-entity-c" });
    const res = await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entity.id, type: "downtime", title: "bad-range",
          starts_at: "2026-08-01T12:00:00Z", ends_at: "2026-08-01T10:00:00Z",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("GET filters events by range", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "ev-entity-d" });
    await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entity.id, type: "downtime", title: "in-range",
          starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z",
        }),
      })
    );
    await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entity.id, type: "downtime", title: "out-of-range",
          starts_at: "2026-09-01T10:00:00Z", ends_at: "2026-09-01T12:00:00Z",
        }),
      })
    );

    const res = await GET(new NextRequest("http://localhost/x?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z"));
    const events = await res.json();
    expect(events.length).toBe(1);
    expect(events[0].title).toBe("in-range");
  });
});
