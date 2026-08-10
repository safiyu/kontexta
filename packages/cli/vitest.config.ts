import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Build dist/ once before the suite so tests that exec `node dist/index.js`
    // never see missing or stale artifacts.
    globalSetup: ['./tests/global-setup.ts'],
    // Boot/health/build steps are slow — start.test.ts already sets its own
    // per-test timeout, but the doctor/mcp probes need more than the default.
    testTimeout: 60_000,
    // `cli bundle` in build.test.ts rebuilds packages/cli/bundle/. Parallel
    // files (e.g. mcp.test.ts) that resolve kontexta-mcp from that bundle
    // would race with it, so run test files serially.
    fileParallelism: false,
  },
});
