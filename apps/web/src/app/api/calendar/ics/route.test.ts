import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";
import { createEntity, createEvent } from "kxta-core";

describe("calendar ics API route", () => {
  it("returns an ICS calendar with the correct headers and content", async () => {
    ensureDbInitialized();
    const entity = createEntity({ name: "ics-entity" });
    createEvent({ entity_id: entity.id, type: "downtime", title: "exportable event", starts_at: "2026-08-01T10:00:00Z", ends_at: "2026-08-01T12:00:00Z" });

    const res = await GET(new NextRequest("http://localhost/x?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("content-disposition")).toContain(".ics");

    const text = await res.text();
    expect(text).toContain("BEGIN:VEVENT");
    expect(text).toContain("exportable event");
  });

  it("requires from and to", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/x"));
    expect(res.status).toBe(400);
  });
});
