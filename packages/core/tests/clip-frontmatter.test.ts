import { describe, it, expect } from "vitest";
import { buildFrontmatter, splitFrontmatter, hashBody } from "../src/clip/frontmatter.js";

describe("buildFrontmatter", () => {
  it("prepends YAML frontmatter with source/title/clipped_at to body", () => {
    const out = buildFrontmatter({
      source: "https://example.com/x",
      title: "Hello",
      clippedAt: "2026-04-30T14:23:00Z",
      body: "# Heading\n\ntext",
    });
    expect(out).toBe(
      "---\nsource: https://example.com/x\ntitle: Hello\nclipped_at: 2026-04-30T14:23:00Z\n---\n\n# Heading\n\ntext"
    );
  });

  it("escapes title containing a colon by quoting", () => {
    const out = buildFrontmatter({
      source: "https://example.com/x",
      title: "Foo: Bar",
      clippedAt: "2026-04-30T14:23:00Z",
      body: "x",
    });
    expect(out).toContain('title: "Foo: Bar"');
  });
});

describe("splitFrontmatter", () => {
  it("returns the body without the leading frontmatter block", () => {
    const file = "---\nsource: u\ntitle: t\nclipped_at: c\n---\n\nbody text";
    expect(splitFrontmatter(file)).toBe("body text");
  });

  it("returns the original string when no frontmatter present", () => {
    expect(splitFrontmatter("just body")).toBe("just body");
  });
});

describe("hashBody", () => {
  it("produces identical hashes for files differing only in clipped_at", () => {
    const a = buildFrontmatter({ source: "u", title: "t", clippedAt: "2026-04-30T00:00:00Z", body: "same" });
    const b = buildFrontmatter({ source: "u", title: "t", clippedAt: "2026-04-30T01:00:00Z", body: "same" });
    expect(hashBody(a)).toBe(hashBody(b));
  });

  it("produces different hashes when body differs", () => {
    const a = buildFrontmatter({ source: "u", title: "t", clippedAt: "x", body: "one" });
    const b = buildFrontmatter({ source: "u", title: "t", clippedAt: "x", body: "two" });
    expect(hashBody(a)).not.toBe(hashBody(b));
  });
});
