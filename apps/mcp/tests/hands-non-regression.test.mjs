import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("a hypothetical Journal-panel save leaves hands.* bytes untouched", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-hands-noreg-"));
  try {
    const configPath = join(testDir, "kontexta.json");
    copyFileSync(
      join(__dirname, "fixtures/kontexta-with-hands-and-journal.json"),
      configPath,
    );

    // Simulate a partial-merge save: read JSON, modify only journal.*, write back.
    const before = readFileSync(configPath, "utf8");
    const obj = JSON.parse(before);
    obj.journal.mode = "strict"; // pretend the user changed mode via Journal panel
    const after = JSON.stringify(obj, null, 2);
    writeFileSync(configPath, after);

    const beforeHands = JSON.stringify(JSON.parse(before).tools, null, 2);
    const afterHands = JSON.stringify(JSON.parse(after).tools, null, 2);
    assert.strictEqual(afterHands, beforeHands);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("Hands schema validation still rejects malformed kontexta.json (Phase 1 baseline check)", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-hands-noreg-"));
  try {
    const configPath = join(testDir, "kontexta.json");
    copyFileSync(
      join(__dirname, "fixtures/kontexta-with-hands-and-journal.json"),
      configPath,
    );
    const obj = JSON.parse(readFileSync(configPath, "utf8"));
    assert.strictEqual(obj.version, "1");
    assert.deepStrictEqual(Object.keys(obj.tools).sort(), ["build", "test"]);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
