import test from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("JournalPanel and LiveStatus modules compile cleanly via tsc", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "kxta-panel-build-"));
  try {
    execSync(
      `pnpm --filter kxta-web exec tsc --jsx preserve --module nodenext --moduleResolution nodenext --target es2022 --outDir ${tmpDir} --skipLibCheck --esModuleInterop --noEmit src/app/docs/journal/journal-panel.tsx src/app/docs/journal/live-status.tsx`,
      { stdio: "pipe", cwd: "/home/user/mygenerators/kontexta" },
    );
    assert.ok(true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Journal panel files exist", () => {
  assert.ok(existsSync("/home/user/mygenerators/kontexta/apps/web/src/app/docs/journal/journal-panel.tsx"));
  assert.ok(existsSync("/home/user/mygenerators/kontexta/apps/web/src/app/docs/journal/live-status.tsx"));
});
