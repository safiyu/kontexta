import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET /api/version-check", () => {
  it("reports an update when the registry version is newer", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "999.0.0" }) })) as any;
    vi.resetModules();
    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(body.updateAvailable).toBe(true);
    expect(body.latestVersion).toBe("999.0.0");
  });

  it("reports no update when the registry version matches the running version", async () => {
    vi.resetModules();
    const { currentVersion } = await import("@/lib/app-version");
    const running = currentVersion();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: running }) })) as any;
    vi.resetModules();
    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(body.updateAvailable).toBe(false);
    expect(body.currentVersion).toBe(running);
  });

  it("fails open (no update) when the registry is unreachable", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;
    vi.resetModules();
    const { GET } = await import("./route");
    const res = await GET();
    const body = await res.json();
    expect(body.updateAvailable).toBe(false);
    expect(body.latestVersion).toBeNull();
  });
});
