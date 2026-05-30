import { describe, it, expect } from "vitest";
import {
  INDEXED_EXTENSIONS,
  isIndexedFile,
  stripIndexedExt,
} from "../src/util/extensions.js";

describe("INDEXED_EXTENSIONS", () => {
  it("includes md and mmd in that order", () => {
    expect(INDEXED_EXTENSIONS).toEqual([".md", ".mmd"]);
  });
});

describe("isIndexedFile", () => {
  it("matches .md", () => {
    expect(isIndexedFile("/a/b/c.md")).toBe(true);
  });
  it("matches .mmd", () => {
    expect(isIndexedFile("/a/b/c.mmd")).toBe(true);
  });
  it("rejects unrelated extensions", () => {
    expect(isIndexedFile("/a/b/c.txt")).toBe(false);
    expect(isIndexedFile("/a/b/c.markdown")).toBe(false);
    expect(isIndexedFile("/a/b/c")).toBe(false);
  });
  it("is case-sensitive (matches discoverFiles behaviour)", () => {
    expect(isIndexedFile("/a/b/c.MD")).toBe(false);
  });
});

describe("stripIndexedExt", () => {
  it("strips .md", () => {
    expect(stripIndexedExt("notes.md")).toBe("notes");
  });
  it("strips .mmd", () => {
    expect(stripIndexedExt("diagram.mmd")).toBe("diagram");
  });
  it("leaves unrelated names alone", () => {
    expect(stripIndexedExt("readme.txt")).toBe("readme.txt");
    expect(stripIndexedExt("plain")).toBe("plain");
  });
  it("operates on basename, not whole path", () => {
    expect(stripIndexedExt("/a/b/diag.mmd")).toBe("/a/b/diag");
  });
});
