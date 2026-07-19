import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";
import { createEntity } from "kxta-core";

describe("calendar links API route", () => {
  it("POST creates a link, GET lists it", async () => {
    ensureDbInitialized();
    const a = createEntity({ name: "link-a" });
    const b = createEntity({ name: "link-b" });

    const res = await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_entity_id: a.id, to_entity_id: b.id, label: "feeds" }),
      })
    );
    expect(res.status).toBe(201);

    const listRes = await GET(new NextRequest(`http://localhost/x?entity_id=${a.id}`));
    const list = await listRes.json();
    expect(list.length).toBe(1);
    expect(list[0].label).toBe("feeds");
  });

  it("POST rejects a self-link", async () => {
    ensureDbInitialized();
    const a = createEntity({ name: "self-link" });
    const res = await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_entity_id: a.id, to_entity_id: a.id }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("DELETE removes a link via query params", async () => {
    ensureDbInitialized();
    const a = createEntity({ name: "unlink-a" });
    const b = createEntity({ name: "unlink-b" });
    await POST(
      new NextRequest("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_entity_id: a.id, to_entity_id: b.id }),
      })
    );

    const res = await DELETE(new NextRequest(`http://localhost/x?from=${a.id}&to=${b.id}`, { method: "DELETE" }));
    const body = await res.json();
    expect(body.removed).toBe(true);
  });

  it("DELETE requires from and to", async () => {
    ensureDbInitialized();
    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }));
    expect(res.status).toBe(400);
  });
});
