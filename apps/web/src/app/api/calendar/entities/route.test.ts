import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";

describe("calendar entities API route", () => {
  it("POST creates an entity, GET lists it", async () => {
    ensureDbInitialized();
    const res = await POST(
      new NextRequest("http://localhost/api/calendar/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "app-01", kind: "server" }),
      })
    );
    expect(res.status).toBe(201);
    const entity = await res.json();
    expect(entity.name).toBe("app-01");
    expect(entity.kind).toBe("server");
    expect(entity.active).toBe(true);

    const listRes = await GET(new NextRequest("http://localhost/api/calendar/entities"));
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((e: any) => e.id === entity.id)).toBe(true);
  });

  it("POST rejects a missing name", async () => {
    ensureDbInitialized();
    const res = await POST(
      new NextRequest("http://localhost/api/calendar/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "server" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects a duplicate name", async () => {
    ensureDbInitialized();
    await POST(
      new NextRequest("http://localhost/api/calendar/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dup" }),
      })
    );
    const res = await POST(
      new NextRequest("http://localhost/api/calendar/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dup" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("GET filters by active_only and kind", async () => {
    ensureDbInitialized();
    await POST(
      new NextRequest("http://localhost/api/calendar/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "active-server", kind: "server" }),
      })
    );
    const res = await GET(new NextRequest("http://localhost/api/calendar/entities?kind=server"));
    const list = await res.json();
    expect(list.every((e: any) => e.kind === "server")).toBe(true);
  });
});
