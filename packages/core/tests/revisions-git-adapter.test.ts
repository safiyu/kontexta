import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../src/db/index.js";
import { createFile, updateFile } from "../src/files/index.js";
import { getHistory, getDiff, restoreVersion } from "../src/git/index.js";

describe("Native Revisions & Git Adapter Integration", () => {
  let testDataDir: string;

  beforeEach(() => {
    testDataDir = mkdtempSync(join(tmpdir(), "kontexta-git-adapter-test-"));
    createDatabase(join(testDataDir, "kontexta.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(testDataDir, { recursive: true, force: true });
  });

  it("transparently tracks revisions and diffs for local KB files via SQLite", async () => {
    // 1. Create file
    const created = await createFile({
      title: "Architecture Doc",
      content: "# Architecture v1\nInitial content\n",
      destination: "knowledge",
      folder: "knowledge/dictionary",
      dataDir: testDataDir,
    });

    // 2. Update file
    await updateFile(
      created.id,
      "# Architecture v2\nUpdated content with more details\n",
      testDataDir
    );

    // 3. getHistory should return 2 revisions from file_revisions
    const history = await getHistory(testDataDir, created.path);
    expect(history.length).toBe(2);
    expect(history[0].message).toContain("Update context file");
    expect(history[1].message).toContain("Create context file");

    const v2Hash = history[0].hash;
    const v1Hash = history[1].hash;

    // 4. getDiff should produce in-memory diff between the two revisions
    const diff = await getDiff(testDataDir, created.path, v1Hash, v2Hash);
    expect(diff).toContain("-# Architecture v1");
    expect(diff).toContain("+# Architecture v2");

    // 5. restoreVersion should roll back content in SQLite
    const restored = await restoreVersion(testDataDir, created.path, v1Hash);
    expect(restored).toBe("# Architecture v1\nInitial content\n");

    // 6. Check history now has 3 entries including restore commit
    const updatedHistory = await getHistory(testDataDir, created.path);
    expect(updatedHistory.length).toBe(3);
    expect(updatedHistory[0].message).toContain("Restore version");
  });
});

