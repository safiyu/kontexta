import { describe, it, expect } from "vitest";
import path from "node:path";
import * as dbInit from "./db-init";

describe("DATA_DIR", () => {
  it("ensureDbInitialized() re-resolves DATA_DIR to the current KONTEXTA_DATA_DIR, not the value captured when this module was first imported", () => {
    // DATA_DIR was already evaluated once at module-import time (before this
    // test, before this file's own beforeEach). Changing the env var here
    // simulates what happens mid test-suite: a later test file sets a fresh
    // temp dir, but a route reading the stale top-level export would never
    // see it — which is exactly how test runs were writing real files into
    // the production knowledge base instead of the test sandbox.
    const freshDir = path.join(path.sep, "tmp", "kxta-web-datadir-regression-check");
    process.env.KONTEXTA_DATA_DIR = freshDir;

    dbInit.ensureDbInitialized();

    expect(dbInit.DATA_DIR).toBe(path.resolve(freshDir));
  });
});
