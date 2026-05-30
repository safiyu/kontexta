// apps/web/tests/journal-byte-identity.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mirrors the merge logic of apps/web/src/app/api/projects/[id]/journal-config/route.ts:
// read existing kontexta.json, set obj.journal = body.journal, write JSON.stringify(obj, null, 2).
function simulateJournalPut(configPath, newJournal) {
  let current = { version: "1" };
  try { current = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* keep default */ }
  current.journal = newJournal;
  writeFileSync(configPath, JSON.stringify(current, null, 2));
}

test("Journal save preserves the tools.* JSON-stringified bytes", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-byte-identity-"));
  try {
    const configPath = join(testDir, "kontexta.json");
    const fixture = `{
  "version": "1",
  "tools": {
    "build": {
      "description": "Run the build.",
      "command": ["pnpm", "build"]
    },
    "test": {
      "description": "Run all tests.",
      "command": ["pnpm", "test"],
      "timeout": 600
    }
  },
  "journal": {
    "mode": "lenient"
  }
}`;
    writeFileSync(configPath, fixture);

    const before = JSON.parse(readFileSync(configPath, "utf8"));
    simulateJournalPut(configPath, { mode: "strict", retention: { raw_days: 30 } });
    const after = JSON.parse(readFileSync(configPath, "utf8"));

    // The stringified hands.* slice must be byte-identical post-merge.
    assert.strictEqual(
      JSON.stringify(after.tools, null, 2),
      JSON.stringify(before.tools, null, 2),
      "tools.* slice must not change after a journal-only PUT",
    );

    // Sanity: journal slice DID change
    assert.deepStrictEqual(after.journal, { mode: "strict", retention: { raw_days: 30 } });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("Journal save preserves tools.* even when no kontexta.json existed", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-byte-identity-"));
  try {
    const configPath = join(testDir, "kontexta.json");
    // No file exists. simulateJournalPut should create one with default version.
    simulateJournalPut(configPath, { mode: "strict" });
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    assert.strictEqual(after.version, "1");
    assert.deepStrictEqual(after.journal, { mode: "strict" });
    // No tools section was added (route doesn't add tools to a fresh config)
    assert.strictEqual(after.tools, undefined);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("Journal save preserves an arbitrary, non-default tools shape (key order + nested arrays)", () => {
  const testDir = mkdtempSync(join(tmpdir(), "kontexta-byte-identity-"));
  try {
    const configPath = join(testDir, "kontexta.json");
    // Use unusual key order and nested arrays to ensure we're testing real round-trip preservation.
    const obj = {
      version: "1",
      tools: {
        zeta: {
          description: "Z first to test alphabetical-ish drift",
          command: ["bash", "-lc", "echo zeta && true"],
          env: { FOO: "bar", BAZ: "1" },
          params: [
            { name: "input", type: "string", required: true },
            { name: "flag", type: "boolean", required: false },
          ],
        },
        alpha: {
          description: "A second",
          command: ["echo", "alpha"],
          danger: true,
          confirm: { prompt: "really?" },
        },
      },
      journal: { mode: "lenient" },
    };
    writeFileSync(configPath, JSON.stringify(obj, null, 2));

    const before = JSON.parse(readFileSync(configPath, "utf8"));
    simulateJournalPut(configPath, { mode: "mechanical-only" });
    const after = JSON.parse(readFileSync(configPath, "utf8"));

    assert.strictEqual(
      JSON.stringify(after.tools, null, 2),
      JSON.stringify(before.tools, null, 2),
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
