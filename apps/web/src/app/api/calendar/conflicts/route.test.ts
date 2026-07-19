import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";
import { createEntity, createEvent } from "kxta-core";

describe("calendar conflicts API route", () => {
  it("returns an overlap conflict for same-entity overlapping events", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "conflict-entity" });
    createEvent({ entity_id: entity.id, type: "downtime", title: "e1", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" });
    createEvent({ entity_id: entity.id, type: "downtime", title: "e2", starts_at: "2026-08-01T11:00:00Z", ends_at: "2026-08-01T13:00:00Z" });

    const res = await GET(new NextRequest("http://localhost/x?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflicts.length).toBe(1);
    expect(body.conflicts[0].kind).toBe("overlap");
  });

  it("flags an insufficient_buffer conflict when buffer_minutes is passed", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "buffer-entity" });
    createEvent({ entity_id: entity.id, type: "downtime", title: "e1", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" });
    createEvent({ entity_id: entity.id, type: "downtime", title: "e2", starts_at: "2026-08-01T12:00:00Z", ends_at: "2026-08-01T13:00:00Z" });

    const res = await GET(new NextRequest("http://localhost/x?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&buffer_minutes=30"));
    const body = await res.json();
    expect(body.conflicts.length).toBe(1);
    expect(body.conflicts[0].kind).toBe("insufficient_buffer");
    expect(body.buffer_minutes).toBe(30);
  });

  it("requires from and to", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/x"));
    expect(res.status).toBe(400);
  });
});
