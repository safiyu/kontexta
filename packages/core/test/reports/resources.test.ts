import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResource, readResource, listResources, deleteResource, resourceUrlFor, mimeFor } from "../../src/reports/resources.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kxta-res-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("resources", () => {
  it("writes bytes and returns info", () => {
    const info = writeResource(root, "Chart One.png", Buffer.from("PNGDATA"));
    expect(info.filename).toBe("chart-one.png");
    expect(info.size).toBe(7);
    expect(info.url).toBe("/api/reports/resources/chart-one.png");
  });

  it("reads back with correct mime", () => {
    writeResource(root, "x.png", Buffer.from("PNG"));
    const { bytes, mime } = readResource(root, "x.png");
    expect(bytes.toString()).toBe("PNG");
    expect(mime).toBe("image/png");
  });

  it("lists resources", () => {
    writeResource(root, "a.png", Buffer.from("A"));
    writeResource(root, "b.svg", Buffer.from("B"));
    const items = listResources(root).map(i => i.filename).sort();
    expect(items).toEqual(["a.png", "b.svg"]);
  });

  it("suffixes on collision with different content", () => {
    writeResource(root, "x.png", Buffer.from("first"));
    const info = writeResource(root, "x.png", Buffer.from("second"));
    expect(info.filename).not.toBe("x.png");
    expect(info.filename.startsWith("x-")).toBe(true);
    expect(info.filename.endsWith(".png")).toBe(true);
  });

  it("returns the same filename on collision with identical content", () => {
    const a = writeResource(root, "x.png", Buffer.from("same"));
    const b = writeResource(root, "x.png", Buffer.from("same"));
    expect(a.filename).toBe(b.filename);
  });

  it("rejects path traversal", () => {
    expect(() => writeResource(root, "../evil.png", Buffer.from("x"))).toThrow();
    expect(() => readResource(root, "../evil.png")).toThrow();
  });

  it("returns application/octet-stream for unknown ext", () => {
    expect(mimeFor("x.weird")).toBe("application/octet-stream");
  });
});
