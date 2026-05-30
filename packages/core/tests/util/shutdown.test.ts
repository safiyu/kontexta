import { describe, it, expect, beforeEach } from "vitest";
import { withLock, inFlightCount, isShuttingDown, setShuttingDown, awaitDrain, track } from "../../src/util/safety.js";

describe("in-flight counter", () => {
  beforeEach(() => {
    setShuttingDown(false);
  });

  it("starts at 0", () => {
    expect(inFlightCount()).toBe(0);
  });

  it("withLock increments and decrements", async () => {
    expect(inFlightCount()).toBe(0);
    const p = withLock("test:a", async () => {
      expect(inFlightCount()).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 5));
    });
    await p;
    expect(inFlightCount()).toBe(0);
  });

  it("withLock decrements on rejection", async () => {
    expect(inFlightCount()).toBe(0);
    await expect(
      withLock("test:b", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(inFlightCount()).toBe(0);
  });

  it("track() also tracks", async () => {
    expect(inFlightCount()).toBe(0);
    const p = track(new Promise<void>((resolve) => setTimeout(resolve, 5)));
    expect(inFlightCount()).toBe(1);
    await p;
    expect(inFlightCount()).toBe(0);
  });
});

describe("awaitDrain", () => {
  beforeEach(() => {
    setShuttingDown(false);
  });

  it("resolves immediately when nothing in flight", async () => {
    const remaining = await awaitDrain(1000);
    expect(remaining).toBe(0);
  });

  it("resolves when in-flight reaches 0", async () => {
    let resolveOp!: () => void;
    const op = withLock("drain:a", () => new Promise<void>((r) => { resolveOp = r; }));
    expect(inFlightCount()).toBe(1);

    const drainPromise = awaitDrain(2000);
    // Drain shouldn't resolve yet
    setTimeout(() => resolveOp(), 20);
    const remaining = await drainPromise;
    expect(remaining).toBe(0);
    await op;
  });

  it("times out and reports remaining count", async () => {
    let resolveOp!: () => void;
    const op = withLock("drain:b", () => new Promise<void>((r) => { resolveOp = r; }));
    expect(inFlightCount()).toBe(1);

    const remaining = await awaitDrain(50);
    expect(remaining).toBe(1);
    // Cleanup
    resolveOp();
    await op;
  });
});

describe("isShuttingDown / setShuttingDown", () => {
  it("toggles", () => {
    setShuttingDown(false);
    expect(isShuttingDown()).toBe(false);
    setShuttingDown(true);
    expect(isShuttingDown()).toBe(true);
    setShuttingDown(false);
  });
});
