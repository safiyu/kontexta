import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffold", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("2.0.10");
  });
});
