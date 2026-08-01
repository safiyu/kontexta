import { getDataDir, ensureDataDir, getDatabase, resetDataDirCache } from "kxta-core";

export let DATA_DIR = getDataDir();

export function ensureDbInitialized() {
  // Force a fresh resolution on every call so this binding never drifts
  // from kxta-core's own (test-resettable) resolution.
  //
  // getDataDir() caches its result in-process and only re-resolves after
  // resetDataDirCache() is called — by design, so a single process doesn't
  // re-read env vars/the cache file on every call. That's harmless in
  // production (the env never changes mid-process) but broke test
  // isolation two ways at once: (1) DATA_DIR used to be a plain constant
  // evaluated once at module-import time — before any test's beforeEach
  // could set KONTEXTA_DATA_DIR — so it permanently cached whatever
  // directory existed at that first import; (2) even after making DATA_DIR
  // a `let` reassigned here, calling getDataDir() again is a no-op while
  // its own cache is still populated, so it kept returning the same stale
  // value regardless of how many times this function re-ran. Resetting the
  // cache immediately before resolving closes both gaps: whichever route
  // handler happens to run first in a shared test process (this app's own
  // test suite runs every file in a single forked process) gets the
  // current KONTEXTA_DATA_DIR instead of silently writing real files into
  // the production knowledge base.
  //
  // Every route calls ensureDbInitialized() before touching DATA_DIR, and
  // ES module imports are live bindings, so reassigning it here is visible
  // to every importer without changing them.
  resetDataDirCache();
  DATA_DIR = getDataDir();
  ensureDataDir();

  if (!globalThis.__kontextaDb) {
    getDatabase(); // Auto-initializes using core's unified path resolution
  }
}
