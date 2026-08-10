import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many core tests exercise real fs + git in temp repos. Windows CI
    // runners are slow enough that individual tests exceed vitest's 5s
    // default (observed: metadata addTags, project-map fixtures). One
    // generous global ceiling beats per-test whack-a-mole; genuinely hung
    // tests still fail, just later.
    testTimeout: 30_000,
    // Windows: file handles (sqlite WAL, watchers) can linger briefly;
    // give temp-dir cleanup hooks the same headroom.
    hookTimeout: 30_000,
  },
});
