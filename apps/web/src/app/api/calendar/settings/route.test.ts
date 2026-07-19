import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import { ensureDbInitialized } from "@/lib/db-init";

describe("calendar settings API route", () => {
  it("GET defaults to 0 when unset", async () => {
    ensureDbInitialized();
    const res = await GET(new NextRequest("http://localhost/x"));
    const body = await res.json();
    expect(body.buffer_minutes).toBe(0);
  });

  it("PUT updates the buffer, GET reflects it", async () => {
    ensureDbInitialized();
    const putRes = await PUT(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buffer_minutes: 45 }),
      })
    );
    expect(putRes.status).toBe(200);

    const getRes = await GET(new NextRequest("http://localhost/x"));
    const body = await getRes.json();
    expect(body.buffer_minutes).toBe(45);
  });

  it("PUT rejects invalid values", async () => {
    ensureDbInitialized();
    const negative = await PUT(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buffer_minutes: -1 }),
      })
    );
    expect(negative.status).toBe(400);

    const nonNumber = await PUT(
      new NextRequest("http://localhost/x", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buffer_minutes: "x" }),
      })
    );
    expect(nonNumber.status).toBe(400);
  });
});
