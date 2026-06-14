import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rejectNul,
  validateNumber,
  validateBoolean,
  isLiteralArgv0,
  compilePattern,
  validateParamValue,
} from "../dist/hands/sanitizer.js";

test("rejectNul throws on NUL byte", () => {
  assert.throws(() => rejectNul("ab\0c"), /NUL/);
  assert.doesNotThrow(() => rejectNul("abc"));
});

test("validateNumber rejects NaN/Infinity/out-of-range", () => {
  assert.throws(() => validateNumber(NaN));
  assert.throws(() => validateNumber(Infinity));
  assert.throws(() => validateNumber(-Infinity));
  assert.throws(() => validateNumber(Number.MAX_SAFE_INTEGER + 1));
  assert.doesNotThrow(() => validateNumber(42));
  assert.throws(() => validateNumber(5, { min: 10 }));
  assert.throws(() => validateNumber(5, { max: 1 }));
  assert.doesNotThrow(() => validateNumber(5, { min: 0, max: 10 }));
});

test("validateBoolean rejects truthy/falsy non-booleans", () => {
  assert.throws(() => validateBoolean(1));
  assert.throws(() => validateBoolean("true"));
  assert.throws(() => validateBoolean(null));
  assert.doesNotThrow(() => validateBoolean(true));
  assert.doesNotThrow(() => validateBoolean(false));
});

test("isLiteralArgv0 rejects substitution", () => {
  assert.equal(isLiteralArgv0("npx"), true);
  assert.equal(isLiteralArgv0("{{cmd}}"), false);
  assert.equal(isLiteralArgv0("ab{{cmd}}"), false);
});

test("compilePattern returns re2-backed matcher", () => {
  const m = compilePattern("^[a-z]+$");
  assert.equal(m.test("abc"), true);
  assert.equal(m.test("ABC"), false);
  assert.throws(() => compilePattern("("), /pattern/i);
});

test("validateParamValue: empty string always passes pattern", () => {
  assert.doesNotThrow(() =>
    validateParamValue("", { type: "string", pattern: "^[a-z]+$" })
  );
});

test("validateParamValue: default pattern rejects leading dash", () => {
  assert.throws(() =>
    validateParamValue("-rf", { type: "string" })
  );
  assert.doesNotThrow(() =>
    validateParamValue("foo", { type: "string" })
  );
});

test("validateParamValue: explicit pattern overrides default", () => {
  assert.doesNotThrow(() =>
    validateParamValue("-x", { type: "string", pattern: "^-[a-z]$" })
  );
});

test("validateParamValue: NUL rejected regardless of pattern", () => {
  assert.throws(() =>
    validateParamValue("foo\0bar", { type: "string", pattern: ".*" })
  );
});

import { loadProjectConfig } from "../dist/hands/loader.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpProject(content) {
  const root = mkdtempSync(join(tmpdir(), "hands-"));
  if (content !== null) writeFileSync(join(root, "kontexta.json"), content);
  return root;
}

test("loader: missing file returns found=false", () => {
  const root = tmpProject(null);
  const r = loadProjectConfig(root);
  assert.equal(r.found, false);
  assert.deepEqual(r.tools, {});
});

test("loader: invalid JSON returns error", () => {
  const root = tmpProject("{ not json");
  const r = loadProjectConfig(root);
  assert.equal(r.found, true);
  assert.match(r.errors[0], /JSON/);
});

test("loader: rejects bad tool name", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: { "BAD NAME": { description: "x", command: ["echo"] } },
  }));
  const r = loadProjectConfig(root);
  assert.equal(Object.keys(r.tools).length, 0);
  assert.ok(r.warnings.some(w => /BAD NAME/.test(w)));
});

test("loader: rejects {{param}} in argv[0]", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: {
      bad: {
        description: "x",
        command: ["{{cmd}}", "arg"],
        params: { cmd: { type: "string" } },
      },
    },
  }));
  const r = loadProjectConfig(root);
  assert.equal(Object.keys(r.tools).length, 0);
  assert.ok(r.warnings.some(w => /argv\[0\]/i.test(w)));
});

test("loader: rejects placeholder without param def", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: { bad: { description: "x", command: ["echo", "{{missing}}"] } },
  }));
  const r = loadProjectConfig(root);
  assert.equal(Object.keys(r.tools).length, 0);
});

test("loader: unused param produces warning, tool still loads", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: {
      ok: {
        description: "x",
        command: ["echo", "hi"],
        params: { unused: { type: "string" } },
      },
    },
  }));
  const r = loadProjectConfig(root);
  assert.ok(r.tools.ok);
  assert.ok(r.warnings.some(w => /unused/i.test(w)));
});

test("loader: rejects workingDir with .. or absolute path", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: { a: { description: "x", command: ["echo"], workingDir: "../etc" } },
  }));
  const r = loadProjectConfig(root);
  assert.equal(Object.keys(r.tools).length, 0);
});

test("loader: rejects PATH/LD_PRELOAD in env", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: { a: { description: "x", command: ["echo"], env: { PATH: "/x" } } },
  }));
  const r = loadProjectConfig(root);
  assert.equal(Object.keys(r.tools).length, 0);
});

test("loader: clamps timeout to 300000", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: { a: { description: "x", command: ["echo"], timeout: 999999 } },
  }));
  const r = loadProjectConfig(root);
  assert.equal(r.tools.a.timeout, 300000);
});

test("loader: disabled tool collected separately", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: {
      a: { description: "x", command: ["echo"], disabled: true },
      b: { description: "y", command: ["echo"] },
    },
  }));
  const r = loadProjectConfig(root);
  assert.deepEqual(r.disabled, ["a"]);
  assert.ok(r.tools.b);
  assert.ok(!r.tools.a);
});

test("loader: invalid params.pattern rejected at load", () => {
  const root = tmpProject(JSON.stringify({
    version: "1",
    tools: {
      a: {
        description: "x",
        command: ["echo", "{{x}}"],
        params: { x: { type: "string", pattern: "(" } },
      },
    },
  }));
  const r = loadProjectConfig(root);
  assert.equal(Object.keys(r.tools).length, 0);
});

import { ConfirmStore } from "../dist/hands/confirm.js";

test("confirm: stash + consume returns the same execute", async () => {
  const store = new ConfirmStore();
  let ran = false;
  const t = store.stash({
    toolName: "p__t", projectName: "p", resolvedArgv: ["echo", "hi"],
    workingDir: "/x", env: {},
    execute: async () => { ran = true; return /** @type any */ ({ status: "success" }); },
  });
  assert.equal(typeof t, "string");
  assert.equal(t.length, 64);
  const consumed = store.consume(t);
  assert.ok(consumed);
  assert.equal(consumed.toolName, "p__t");
  await consumed.execute();
  assert.equal(ran, true);
  assert.equal(store.consume(t), null);
});

test("confirm: tokens are unique per call", () => {
  const store = new ConfirmStore();
  const a = store.stash({
    toolName: "p__t", projectName: "p", resolvedArgv: ["echo"],
    workingDir: "/x", env: {}, execute: async () => /** @type any */ ({}),
  });
  const b = store.stash({
    toolName: "p__t", projectName: "p", resolvedArgv: ["echo"],
    workingDir: "/x", env: {}, execute: async () => /** @type any */ ({}),
  });
  assert.notEqual(a, b);
});

test("confirm: expired tokens are not consumable", async () => {
  const store = new ConfirmStore({ ttlMs: 50 });
  const t = store.stash({
    toolName: "p__t", projectName: "p", resolvedArgv: ["echo"],
    workingDir: "/x", env: {}, execute: async () => /** @type any */ ({}),
  });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(store.consume(t), null);
});

import { resolveArgv, executeHand } from "../dist/hands/executor.js";

test("resolveArgv: substitutes per element, drops empty resolved elements", () => {
  const argv = resolveArgv(
    ["echo", "{{a}}", "--name={{b}}"],
    { a: "", b: "" },
    {
      a: { type: "string", required: false, default: "" },
      b: { type: "string", required: false, default: "" },
    },
    false
  );
  // Both {{a}} and --name={{b}} are dropped because their values are empty
  assert.deepEqual(argv, ["echo"]);
});

test("resolveArgv: substitutes non-empty values, leaves whitespace intact", () => {
  const argv = resolveArgv(
    ["vitest", "--name={{f}}"],
    { f: "auth flow" },
    { f: { type: "string", pattern: "^[a-zA-Z ]+$" } },
    false
  );
  assert.deepEqual(argv, ["vitest", "--name=auth flow"]);
});

test("resolveArgv: argSeparator inserts -- before first substituted element", () => {
  const argv = resolveArgv(
    ["rm", "{{path}}"],
    { path: "foo.txt" },
    { path: { type: "string", pattern: "^[a-z.]+$" } },
    true
  );
  assert.deepEqual(argv, ["rm", "--", "foo.txt"]);
});

test("resolveArgv: rejects undefined required param", () => {
  assert.throws(() =>
    resolveArgv(
      ["echo", "{{x}}"],
      {},
      { x: { type: "string", required: true } },
      false
    ),
    /required/
  );
});

test("resolveArgv: applies default for missing optional param", () => {
  const argv = resolveArgv(
    ["echo", "{{x}}"],
    {},
    { x: { type: "string", required: false, default: "hello" } },
    false
  );
  assert.deepEqual(argv, ["echo", "hello"]);
});

test("executeHand: runs simple echo, captures stdout", async () => {
  const result = await executeHand({
    toolDef: {
      description: "x",
      command: ["echo", "hello-world"],
      timeout: 5000,
      maxOutputBytes: 100000,
      env: {},
      params: {},
    },
    params: {},
    projectRoot: process.cwd(),
  });
  assert.equal(result.status, "success");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello-world/);
});

test("executeHand: reports failed exit", async () => {
  const result = await executeHand({
    toolDef: {
      description: "x",
      command: ["sh", "-c", "exit 7"],
      timeout: 5000,
      maxOutputBytes: 100000,
      env: {},
      params: {},
    },
    params: {},
    projectRoot: process.cwd(),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
});

test("executeHand: timeout kills process group, returns timeout status", async () => {
  const result = await executeHand({
    toolDef: {
      description: "x",
      command: ["sh", "-c", "sleep 10"],
      timeout: 200,
      maxOutputBytes: 100000,
      env: {}, params: {},
    },
    params: {},
    projectRoot: process.cwd(),
  });
  assert.equal(result.status, "timeout");
});

test("executeHand: large stdout is truncated", async () => {
  const result = await executeHand({
    toolDef: {
      description: "x",
      command: ["sh", "-c", "yes hello | head -c 500000"],
      timeout: 5000,
      maxOutputBytes: 50000,
      env: {}, params: {},
    },
    params: {},
    projectRoot: process.cwd(),
  });
  assert.equal(result.status, "success");
  assert.ok(result.stdout.includes("[truncated"), "expected truncation marker");
  assert.ok(result.stdout.length < 100000, `stdout length ${result.stdout.length}`);
});

test("executeHand: ring buffer keeps head and tail under sustained pressure", async () => {
  // Generate 200KB of distinct content (numbered lines), cap at 10KB.
  // Verify the marker exists and that we keep the very first lines and very last lines.
  const result = await executeHand({
    toolDef: {
      description: "x",
      command: ["sh", "-c", "i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done"],
      timeout: 10000,
      maxOutputBytes: 10000,
      env: {}, params: {},
    },
    params: {},
    projectRoot: process.cwd(),
  });
  assert.equal(result.status, "success");
  assert.ok(result.stdout.includes("[truncated"), "expected marker");
  assert.ok(result.stdout.startsWith("line-0"), "expected to keep first line");
  assert.match(result.stdout, /line-4999\s*$/, "expected to keep last line");
});

import { formatExecResult, formatPendingConfirm } from "../dist/hands/formatter.js";

test("formatter: success result renders as markdown", () => {
  const md = formatExecResult("p__t", {
    status: "success", exitCode: 0, durationMs: 1234,
    workingDir: "/x", stdout: "hi", stderr: "",
    resolvedArgv: ["echo", "hi"],
  });
  assert.match(md, /## Tool: p__t/);
  assert.match(md, /Success/);
  assert.match(md, /1\.2s/);
  assert.match(md, /```\nhi\n```/);
  assert.ok(!md.includes("### stderr"), "stderr section omitted when empty");
});

test("formatter: pending confirm shows resolved argv", () => {
  const md = formatPendingConfirm({
    toolName: "p__deploy",
    projectName: "p",
    resolvedArgv: ["gcloud", "run", "deploy", "svc"],
    workingDir: "/x",
    token: "abc123",
  });
  assert.match(md, /requires human approval/i);
  assert.match(md, /\[0\] gcloud/);
  assert.match(md, /\[3\] svc/);
  assert.match(md, /confirm_hand/);
  assert.match(md, /abc123/);
});
