# `kontexta-mcp init` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided `init` subcommand to the `kontexta-mcp` CLI that creates the data dir, registers a first project, and configures detected MCP clients in one flow.

**Architecture:** New `apps/mcp/src/init/` directory containing a 5-phase orchestrator (data dir → project → detect → write → hint). Per-client writers implement four strategies: `auto-cli` (Claude Code), `auto-json-merge` (Cursor / Claude Desktop / Antigravity), `auto-file-write` (Continue), and `copy-paste` (Codex / Gemini / Aider). Snippet content shared with the web UI via a moved `install-templates` module in `packages/core`.

**Tech Stack:** TypeScript, Node.js `node:test` runner, `@clack/prompts` for TTY prompts, no other new deps. Tests import from `dist/` so each test cycle runs `pnpm --filter kontexta-mcp build` first.

**Spec:** [`docs/superpowers/specs/2026-05-18-mcp-init-cli-design.md`](../specs/2026-05-18-mcp-init-cli-design.md)

---

## File Map

**New files:**
- `apps/mcp/src/init/index.ts` — entry invoked by CLI router
- `apps/mcp/src/init/types.ts` — shared types
- `apps/mcp/src/init/args.ts` — flag parsing
- `apps/mcp/src/init/detect.ts` — per-OS client detection
- `apps/mcp/src/init/prompts.ts` — TTY-aware prompt wrappers
- `apps/mcp/src/init/flow.ts` — 5-phase orchestrator
- `apps/mcp/src/init/snippets.ts` — wrapper over core's install-templates
- `apps/mcp/src/init/writers/index.ts` — strategy dispatch
- `apps/mcp/src/init/writers/claude-code.ts` — `auto-cli`
- `apps/mcp/src/init/writers/json-merge.ts` — shared `auto-json-merge`
- `apps/mcp/src/init/writers/continue.ts` — `auto-file-write`
- `apps/mcp/src/init/writers/copy-paste.ts` — print snippet + path
- `packages/core/src/install-templates.ts` — moved from `apps/web/src/lib/`
- `apps/mcp/tests/init-args.test.mjs`
- `apps/mcp/tests/init-detect.test.mjs`
- `apps/mcp/tests/init-writer-json-merge.test.mjs`
- `apps/mcp/tests/init-writer-continue.test.mjs`
- `apps/mcp/tests/init-writer-claude-code.test.mjs`
- `apps/mcp/tests/init-flow.test.mjs`
- `apps/mcp/tests/init-integration.test.mjs`

**Modified files:**
- `apps/mcp/src/index.ts` — add CLI router that dispatches `init` subcommand
- `apps/mcp/package.json` — add `@clack/prompts` dep
- `apps/web/src/lib/install-templates.ts` — replace with re-export from core
- `packages/core/src/index.ts` — export install-templates
- `apps/mcp/README.md` — document `init` command
- `README.md` — update Quick Start to mention `npx kontexta-mcp init`
- `CHANGELOG.md` — add entry

---

## Task 1: Refactor — Move install-templates to packages/core

**Files:**
- Create: `packages/core/src/install-templates.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/web/src/lib/install-templates.ts` (becomes re-export)
- Modify: `apps/web/src/app/api/install-snippets/route.ts` (update import)

- [ ] **Step 1: Copy file to core**

```bash
cp apps/web/src/lib/install-templates.ts packages/core/src/install-templates.ts
```

- [ ] **Step 2: Export from core index**

Open `packages/core/src/index.ts` and add at the end:

```typescript
export * from "./install-templates.js";
```

- [ ] **Step 3: Replace web copy with re-export**

Overwrite `apps/web/src/lib/install-templates.ts` with:

```typescript
export {
  CLIENTS,
  INSTALLS,
  renderTemplate,
} from "kxta-core";
export type {
  Client,
  Install,
  TemplateVars,
  Snippet,
} from "kxta-core";
```

- [ ] **Step 4: Verify imports still resolve in web**

The route at `apps/web/src/app/api/install-snippets/route.ts` imports from `@/lib/install-templates` — the re-export keeps that path working. No change needed.

- [ ] **Step 5: Build core, then web, to verify**

Run: `pnpm --filter kxta-core build && pnpm --filter web build`
Expected: both build with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/install-templates.ts packages/core/src/index.ts apps/web/src/lib/install-templates.ts
git commit -m "refactor(core): move install-templates from web to core for CLI reuse"
```

---

## Task 2: Add @clack/prompts dependency

**Files:**
- Modify: `apps/mcp/package.json`

- [ ] **Step 1: Add the dep**

Run from repo root: `pnpm --filter kontexta-mcp add @clack/prompts@^0.7.0`

- [ ] **Step 2: Verify lockfile updated**

Run: `git diff pnpm-lock.yaml | head -20`
Expected: shows `@clack/prompts` and its transitive deps added.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/package.json pnpm-lock.yaml
git commit -m "chore(mcp): add @clack/prompts for init CLI"
```

---

## Task 3: Define shared types

**Files:**
- Create: `apps/mcp/src/init/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
import type { Client } from "kxta-core";

export type Strategy =
  | "auto-cli"
  | "auto-json-merge"
  | "auto-file-write"
  | "copy-paste";

export interface ClientStatus {
  id: Client;
  label: string;
  detected: boolean;
  strategy: Strategy;
  /** Resolved absolute config path (or null for `auto-cli`). */
  configPath: string | null;
  /** Human-readable reason for detection state or path resolution. */
  note?: string;
}

export type PhaseOutcome =
  | { kind: "ok"; message: string }
  | { kind: "skipped"; message: string }
  | { kind: "warn"; message: string; snippet?: string }
  | { kind: "error"; message: string };

export interface InitArgs {
  project?: string;
  noProject: boolean;
  clients?: Client[];
  noClients: boolean;
  dataDir?: string;
  yes: boolean;
}

export interface InitContext {
  args: InitArgs;
  isTTY: boolean;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mcp/src/init/types.ts
git commit -m "feat(mcp/init): scaffold shared types"
```

---

## Task 4: Implement args parser (TDD)

**Files:**
- Create: `apps/mcp/src/init/args.ts`
- Test: `apps/mcp/tests/init-args.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp/tests/init-args.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInitArgs } from "../dist/init/args.js";

test("parses --yes flag", () => {
  const args = parseInitArgs(["--yes"]);
  assert.equal(args.yes, true);
});

test("parses -y as alias for --yes", () => {
  const args = parseInitArgs(["-y"]);
  assert.equal(args.yes, true);
});

test("parses --project with value", () => {
  const args = parseInitArgs(["--project", "/tmp/foo"]);
  assert.equal(args.project, "/tmp/foo");
});

test("parses --no-project to set noProject true", () => {
  const args = parseInitArgs(["--no-project"]);
  assert.equal(args.noProject, true);
  assert.equal(args.project, undefined);
});

test("parses --clients as comma-separated list", () => {
  const args = parseInitArgs(["--clients", "claude-code,cursor"]);
  assert.deepEqual(args.clients, ["claude-code", "cursor"]);
});

test("rejects unknown client ids with helpful error", () => {
  assert.throws(
    () => parseInitArgs(["--clients", "claude-code,bogus"]),
    /Unknown client.*bogus.*valid IDs/i,
  );
});

test("rejects unknown flag", () => {
  assert.throws(
    () => parseInitArgs(["--mystery"]),
    /Unknown flag/i,
  );
});

test("defaults: nothing set means yes=false, noProject=false, noClients=false", () => {
  const args = parseInitArgs([]);
  assert.equal(args.yes, false);
  assert.equal(args.noProject, false);
  assert.equal(args.noClients, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-args.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement args parser**

Create `apps/mcp/src/init/args.ts`:

```typescript
import { CLIENTS, type Client } from "kxta-core";
import type { InitArgs } from "./types.js";

export function parseInitArgs(argv: string[]): InitArgs {
  const out: InitArgs = {
    noProject: false,
    noClients: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--no-project":
        out.noProject = true;
        break;
      case "--no-clients":
        out.noClients = true;
        break;
      case "--project":
        out.project = argv[++i];
        if (!out.project) throw new Error("--project requires a value");
        break;
      case "--data-dir":
        out.dataDir = argv[++i];
        if (!out.dataDir) throw new Error("--data-dir requires a value");
        break;
      case "--clients": {
        const v = argv[++i];
        if (!v) throw new Error("--clients requires a value");
        const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
        const valid = new Set<string>(CLIENTS as readonly string[]);
        const bad = ids.filter((id) => !valid.has(id));
        if (bad.length) {
          throw new Error(
            `Unknown client(s): ${bad.join(", ")}. valid IDs: ${CLIENTS.join(", ")}`,
          );
        }
        out.clients = ids as Client[];
        break;
      }
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-args.test.mjs`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/init/args.ts apps/mcp/tests/init-args.test.mjs
git commit -m "feat(mcp/init): parse CLI flags for init command"
```

---

## Task 5: Implement client detection (TDD)

**Files:**
- Create: `apps/mcp/src/init/detect.ts`
- Test: `apps/mcp/tests/init-detect.test.mjs`

**Note for engineer:** The path table below is the *intent*. **Before merging this task,** verify each path against current (2026) docs for each client. The web UI's existing `install-templates.ts` config paths are known to be partially stale for Gemini and Codex.

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp/tests/init-detect.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClients } from "../dist/init/detect.js";

function makeCtx(overrides) {
  const home = mkdtempSync(join(tmpdir(), "kontexta-detect-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
    ctx: {
      args: { noProject: false, noClients: false, yes: true },
      isTTY: false,
      cwd: home,
      platform: "linux",
      env: { HOME: home },
      homeDir: home,
      ...overrides,
    },
  };
}

test("Claude Code: detected when claude binary present (PATH probe)", () => {
  const { ctx, cleanup } = makeCtx({ env: { HOME: "/x", PATH: "/usr/local/bin" } });
  try {
    const list = detectClients(ctx.ctx);
    const cc = list.find((c) => c.id === "claude-code");
    assert.ok(cc, "claude-code entry exists");
    assert.equal(cc.strategy, "auto-cli");
  } finally { cleanup(); }
});

test("Cursor: detected when ~/.cursor/mcp.json exists", () => {
  const { home, ctx, cleanup } = makeCtx();
  try {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{}");
    const list = detectClients(ctx);
    const cur = list.find((c) => c.id === "cursor");
    assert.equal(cur.detected, true);
    assert.equal(cur.strategy, "auto-json-merge");
    assert.equal(cur.configPath, join(home, ".cursor", "mcp.json"));
  } finally { cleanup(); }
});

test("Cursor: not-detected entry still returned with resolvable path", () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const list = detectClients(ctx);
    const cur = list.find((c) => c.id === "cursor");
    assert.equal(cur.detected, false);
    assert.ok(cur.configPath?.endsWith(".cursor/mcp.json"));
  } finally { cleanup(); }
});

test("Continue: detected when ~/.continue/ exists", () => {
  const { home, ctx, cleanup } = makeCtx();
  try {
    mkdirSync(join(home, ".continue", "mcpServers"), { recursive: true });
    const list = detectClients(ctx);
    const co = list.find((c) => c.id === "continue");
    assert.equal(co.detected, true);
    assert.equal(co.strategy, "auto-file-write");
  } finally { cleanup(); }
});

test("Codex / Gemini / Aider always carry strategy=copy-paste", () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const list = detectClients(ctx);
    for (const id of ["codex", "gemini", "aider"]) {
      const e = list.find((c) => c.id === id);
      assert.equal(e.strategy, "copy-paste", `${id} should be copy-paste`);
    }
  } finally { cleanup(); }
});

test("Claude Desktop on macOS uses Library path", () => {
  const { home, ctx, cleanup } = makeCtx({ platform: "darwin" });
  try {
    const list = detectClients({ ...ctx, platform: "darwin" });
    const cd = list.find((c) => c.id === "claude-desktop");
    assert.ok(cd.configPath?.includes("Library/Application Support/Claude"));
  } finally { cleanup(); }
});

test("Claude Desktop on Windows uses APPDATA path", () => {
  const { ctx, cleanup } = makeCtx({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
  });
  try {
    const list = detectClients({ ...ctx, platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } });
    const cd = list.find((c) => c.id === "claude-desktop");
    assert.ok(cd.configPath?.includes("AppData"));
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-detect.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement detection**

Create `apps/mcp/src/init/detect.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CLIENTS, type Client } from "kxta-core";
import type { ClientStatus, InitContext, Strategy } from "./types.js";

interface Descriptor {
  id: Client;
  label: string;
  strategy: Strategy;
  /** Returns the resolved absolute config path for the platform, or null for auto-cli. */
  resolvePath(ctx: InitContext): string | null;
  /** Returns true if the client appears installed. */
  isDetected(ctx: InitContext): boolean;
}

function claudeCodeOnPath(): boolean {
  try {
    execSync("claude --version", { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

const DESCRIPTORS: Descriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    strategy: "auto-cli",
    resolvePath: () => null,
    isDetected: () => claudeCodeOnPath(),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    strategy: "auto-json-merge",
    resolvePath: (ctx) => {
      if (ctx.platform === "darwin") {
        return join(ctx.homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (ctx.platform === "win32") {
        const appdata = ctx.env.APPDATA ?? join(ctx.homeDir, "AppData", "Roaming");
        return join(appdata, "Claude", "claude_desktop_config.json");
      }
      return join(ctx.homeDir, ".config", "Claude", "claude_desktop_config.json");
    },
    isDetected: (ctx) => {
      const p = DESCRIPTORS.find((d) => d.id === "claude-desktop")!.resolvePath(ctx);
      return p != null && existsSync(p);
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    strategy: "auto-json-merge",
    resolvePath: (ctx) => join(ctx.homeDir, ".cursor", "mcp.json"),
    isDetected: (ctx) => existsSync(join(ctx.homeDir, ".cursor", "mcp.json")),
  },
  {
    id: "codex",
    label: "Codex",
    strategy: "copy-paste",
    resolvePath: (ctx) => join(ctx.homeDir, ".codex", "config.toml"),
    isDetected: (ctx) => existsSync(join(ctx.homeDir, ".codex")),
  },
  {
    id: "gemini",
    label: "Gemini",
    strategy: "copy-paste",
    resolvePath: (ctx) => join(ctx.homeDir, ".gemini", "settings.json"),
    isDetected: (ctx) => existsSync(join(ctx.homeDir, ".gemini")),
  },
  {
    id: "antigravity",
    label: "Antigravity",
    strategy: "auto-json-merge",
    // PATH NOT YET VERIFIED — confirm against current Antigravity docs before ship.
    resolvePath: (ctx) => join(ctx.homeDir, ".antigravity", "mcp.json"),
    isDetected: (ctx) => existsSync(join(ctx.homeDir, ".antigravity")),
  },
  {
    id: "continue",
    label: "Continue",
    strategy: "auto-file-write",
    resolvePath: (ctx) => join(ctx.homeDir, ".continue", "mcpServers", "kontexta.yaml"),
    isDetected: (ctx) => existsSync(join(ctx.homeDir, ".continue")),
  },
  {
    id: "aider",
    label: "Aider",
    strategy: "copy-paste",
    resolvePath: (ctx) => join(ctx.cwd, ".aider.conf.yml"),
    isDetected: (ctx) => existsSync(join(ctx.cwd, ".aider.conf.yml")) ||
                          existsSync(join(ctx.homeDir, ".aider.conf.yml")),
  },
];

export function detectClients(ctx: InitContext): ClientStatus[] {
  return DESCRIPTORS.map((d) => ({
    id: d.id,
    label: d.label,
    strategy: d.strategy,
    detected: d.isDetected(ctx),
    configPath: d.resolvePath(ctx),
  }));
}

// Type-safety guard: ensure every CLIENTS entry has a descriptor.
{
  const ids = new Set(DESCRIPTORS.map((d) => d.id));
  for (const c of CLIENTS) {
    if (c === "generic") continue;
    if (!ids.has(c)) throw new Error(`Missing init descriptor for client: ${c}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-detect.test.mjs`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/init/detect.ts apps/mcp/tests/init-detect.test.mjs
git commit -m "feat(mcp/init): detect installed MCP clients per OS"
```

---

## Task 6: Implement copy-paste writer

**Files:**
- Create: `apps/mcp/src/init/snippets.ts`
- Create: `apps/mcp/src/init/writers/copy-paste.ts`

- [ ] **Step 1: Create snippets wrapper**

Create `apps/mcp/src/init/snippets.ts`:

```typescript
import { renderTemplate, type Client, type Install, type TemplateVars } from "kxta-core";

/**
 * Returns the snippet for a client + install variant. Thin wrapper so other
 * init modules don't need to know about TemplateVars assembly.
 */
export function getSnippet(client: Client, install: Install, vars: TemplateVars) {
  return renderTemplate(client, install, vars);
}
```

- [ ] **Step 2: Implement copy-paste writer**

Create `apps/mcp/src/init/writers/copy-paste.ts`:

```typescript
import type { Client } from "kxta-core";
import type { ClientStatus, InitContext, PhaseOutcome } from "../types.js";
import { getSnippet } from "../snippets.js";

interface Args {
  client: ClientStatus;
  ctx: InitContext;
  vars: { dataDir: string; version: string; sourceEntrypoint: string };
}

export function writeCopyPaste({ client, vars }: Args): PhaseOutcome {
  const snippet = getSnippet(client.id, "npm", vars);
  const where = client.configPath ?? "(see snippet for path)";
  const body = [
    `--- ${client.label} — paste this into: ${where} ---`,
    snippet.body,
    snippet.notes.length ? `Notes: ${snippet.notes.join(" / ")}` : "",
  ].filter(Boolean).join("\n");
  return {
    kind: "warn",
    message: `${client.label} requires manual paste`,
    snippet: body,
  };
}
```

- [ ] **Step 3: Build to verify compilation**

Run: `pnpm --filter kontexta-mcp build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/init/snippets.ts apps/mcp/src/init/writers/copy-paste.ts
git commit -m "feat(mcp/init): copy-paste writer for unsupported auto-write clients"
```

---

## Task 7: Implement JSON-merge writer (TDD)

**Files:**
- Create: `apps/mcp/src/init/writers/json-merge.ts`
- Test: `apps/mcp/tests/init-writer-json-merge.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp/tests/init-writer-json-merge.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeJsonMerge } from "../dist/init/writers/json-merge.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kontexta-jm-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const vars = { dataDir: "/tmp/data", version: "2.0.2", sourceEntrypoint: "/x/index.js" };

test("creates file when missing", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "mcp.json");
    const out = writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: false, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "ok");
    const written = JSON.parse(readFileSync(target, "utf-8"));
    assert.ok(written.mcpServers?.kxta);
  } finally { cleanup(); }
});

test("merges into existing file preserving other servers", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "mcp.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    const merged = JSON.parse(readFileSync(target, "utf-8"));
    assert.ok(merged.mcpServers.other);
    assert.ok(merged.mcpServers.kxta);
  } finally { cleanup(); }
});

test("writes backup before modifying", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "mcp.json");
    writeFileSync(target, JSON.stringify({ mcpServers: {} }));
    writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    const backups = readdirSync(dir).filter((f) => f.startsWith("mcp.json.kontexta-bak-"));
    assert.equal(backups.length, 1);
  } finally { cleanup(); }
});

test("yes-mode: refuses to overwrite different kxta entry, returns warn", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "mcp.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { kxta: { command: "old-thing" } } }));
    const out = writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "warn");
    const unchanged = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(unchanged.mcpServers.kxta.command, "old-thing");
  } finally { cleanup(); }
});

test("returns ok with already-configured message when identical entry exists", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "mcp.json");
    // First write
    writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    // Second write should detect identical and skip
    const out = writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "ok");
    assert.match(out.message, /already configured|unchanged/i);
  } finally { cleanup(); }
});

test("returns error if existing file is invalid JSON", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "mcp.json");
    writeFileSync(target, "{ not valid json");
    const out = writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "error");
    assert.match(out.message, /parse|invalid/i);
  } finally { cleanup(); }
});

test("creates parent directories when missing", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "nested", "deeper", "mcp.json");
    const out = writeJsonMerge({
      client: { id: "cursor", label: "Cursor", strategy: "auto-json-merge", detected: false, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "ok");
    assert.ok(existsSync(target));
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-writer-json-merge.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement json-merge writer**

Create `apps/mcp/src/init/writers/json-merge.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientStatus, PhaseOutcome } from "../types.js";

interface Args {
  client: ClientStatus;
  vars: { dataDir: string; version: string; sourceEntrypoint: string };
  /** When true, never overwrite an existing-but-different kxta entry. */
  yesMode: boolean;
  /** Optional override; if false, the user already said no at a prompt. */
  overwriteApproved?: boolean;
}

interface KxtaEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function buildKxtaEntry(vars: Args["vars"]): KxtaEntry {
  return {
    command: "npx",
    args: ["-y", "kontexta-mcp"],
    env: { KONTEXTA_DATA_DIR: vars.dataDir },
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function writeJsonMerge(opts: Args): PhaseOutcome {
  const { client, vars, yesMode, overwriteApproved } = opts;
  if (!client.configPath) {
    return { kind: "error", message: `${client.label}: no config path resolved` };
  }
  const path = client.configPath;
  const newEntry = buildKxtaEntry(vars);

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e: any) {
      return { kind: "error", message: `${client.label}: read failed: ${e.message}` };
    }
    try {
      existing = raw.trim() ? JSON.parse(raw) : {};
    } catch (e: any) {
      return {
        kind: "error",
        message: `${client.label}: failed to parse existing config (${e.message}). File left untouched.`,
      };
    }

    const servers = (existing as any).mcpServers as Record<string, unknown> | undefined;
    if (servers?.kxta) {
      if (deepEqual(servers.kxta, newEntry)) {
        return { kind: "ok", message: `${client.label} already configured (unchanged)` };
      }
      if (yesMode && !overwriteApproved) {
        return {
          kind: "warn",
          message: `${client.label}: existing kxta entry differs; skipped to avoid clobbering (re-run without --yes to overwrite)`,
        };
      }
      // overwriteApproved or non-yes mode where prompt happened above us
    }

    // Backup before modifying
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(path, `${path}.kontexta-bak-${ts}`);
    } catch (e: any) {
      return { kind: "error", message: `${client.label}: backup failed: ${e.message}` };
    }
  } else {
    // Ensure parent dir exists for new file
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e: any) {
      return { kind: "error", message: `${client.label}: mkdir failed: ${e.message}` };
    }
  }

  const merged = {
    ...existing,
    mcpServers: {
      ...(existing as any).mcpServers,
      kxta: newEntry,
    },
  };

  try {
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch (e: any) {
    return { kind: "error", message: `${client.label}: write failed: ${e.message}` };
  }

  return { kind: "ok", message: `${client.label} configured → ${path}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-writer-json-merge.test.mjs`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/init/writers/json-merge.ts apps/mcp/tests/init-writer-json-merge.test.mjs
git commit -m "feat(mcp/init): JSON merge writer with backup + idempotency"
```

---

## Task 8: Implement Continue writer (TDD)

**Files:**
- Create: `apps/mcp/src/init/writers/continue.ts`
- Test: `apps/mcp/tests/init-writer-continue.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp/tests/init-writer-continue.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeContinue } from "../dist/init/writers/continue.js";

const vars = { dataDir: "/tmp/data", version: "2.0.2", sourceEntrypoint: "/x/index.js" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kontexta-cont-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("creates the YAML file", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "kontexta.yaml");
    const out = writeContinue({
      client: { id: "continue", label: "Continue", strategy: "auto-file-write", detected: false, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "ok");
    const body = readFileSync(target, "utf-8");
    assert.match(body, /mcpServers:/);
    assert.match(body, /kxta/);
    assert.match(body, /KONTEXTA_DATA_DIR/);
  } finally { cleanup(); }
});

test("returns ok-already-configured if file exists with identical content", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "kontexta.yaml");
    writeContinue({
      client: { id: "continue", label: "Continue", strategy: "auto-file-write", detected: false, configPath: target },
      vars,
      yesMode: true,
    });
    const out = writeContinue({
      client: { id: "continue", label: "Continue", strategy: "auto-file-write", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "ok");
    assert.match(out.message, /already configured|unchanged/i);
  } finally { cleanup(); }
});

test("yes-mode: refuses to overwrite if file exists with different content", () => {
  const { dir, cleanup } = setup();
  try {
    const target = join(dir, "kontexta.yaml");
    writeFileSync(target, "name: something-else\n");
    const out = writeContinue({
      client: { id: "continue", label: "Continue", strategy: "auto-file-write", detected: true, configPath: target },
      vars,
      yesMode: true,
    });
    assert.equal(out.kind, "warn");
    assert.equal(readFileSync(target, "utf-8"), "name: something-else\n");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-writer-continue.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Continue writer**

Create `apps/mcp/src/init/writers/continue.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientStatus, PhaseOutcome } from "../types.js";

interface Args {
  client: ClientStatus;
  vars: { dataDir: string; version: string; sourceEntrypoint: string };
  yesMode: boolean;
  overwriteApproved?: boolean;
}

function renderYaml(vars: Args["vars"]): string {
  return [
    `name: kontexta`,
    `version: ${vars.version}`,
    `schema: v1`,
    `mcpServers:`,
    `  - name: kxta`,
    `    command: "npx"`,
    `    args:`,
    `      - "-y"`,
    `      - "kontexta-mcp"`,
    `    env:`,
    `      KONTEXTA_DATA_DIR: "${vars.dataDir}"`,
    ``,
  ].join("\n");
}

export function writeContinue(opts: Args): PhaseOutcome {
  const { client, vars, yesMode, overwriteApproved } = opts;
  if (!client.configPath) {
    return { kind: "error", message: `${client.label}: no config path resolved` };
  }
  const path = client.configPath;
  const desired = renderYaml(vars);

  if (existsSync(path)) {
    let current: string;
    try { current = readFileSync(path, "utf-8"); } catch (e: any) {
      return { kind: "error", message: `${client.label}: read failed: ${e.message}` };
    }
    if (current === desired) {
      return { kind: "ok", message: `${client.label} already configured (unchanged)` };
    }
    if (yesMode && !overwriteApproved) {
      return {
        kind: "warn",
        message: `${client.label}: existing file differs; skipped to avoid clobbering (re-run without --yes to overwrite)`,
      };
    }
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(path, `${path}.kontexta-bak-${ts}`);
    } catch (e: any) {
      return { kind: "error", message: `${client.label}: backup failed: ${e.message}` };
    }
  } else {
    try { mkdirSync(dirname(path), { recursive: true }); } catch (e: any) {
      return { kind: "error", message: `${client.label}: mkdir failed: ${e.message}` };
    }
  }

  try {
    writeFileSync(path, desired, "utf-8");
  } catch (e: any) {
    return { kind: "error", message: `${client.label}: write failed: ${e.message}` };
  }
  return { kind: "ok", message: `${client.label} configured → ${path}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-writer-continue.test.mjs`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/init/writers/continue.ts apps/mcp/tests/init-writer-continue.test.mjs
git commit -m "feat(mcp/init): Continue writer for standalone YAML file"
```

---

## Task 9: Implement Claude Code writer (TDD)

**Files:**
- Create: `apps/mcp/src/init/writers/claude-code.ts`
- Test: `apps/mcp/tests/init-writer-claude-code.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp/tests/init-writer-claude-code.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeClaudeCode } from "../dist/init/writers/claude-code.js";

const vars = { dataDir: "/tmp/data", version: "2.0.2", sourceEntrypoint: "/x/index.js" };

test("falls back to copy-paste warn when claude CLI is missing", () => {
  const out = writeClaudeCode({
    client: { id: "claude-code", label: "Claude Code", strategy: "auto-cli", detected: false, configPath: null },
    vars,
    yesMode: true,
    runner: { run: () => ({ ok: false, error: "command not found" }) },
  });
  assert.equal(out.kind, "warn");
  assert.match(out.snippet ?? "", /claude mcp add/);
});

test("returns ok when runner reports success", () => {
  let receivedCmd = "";
  const out = writeClaudeCode({
    client: { id: "claude-code", label: "Claude Code", strategy: "auto-cli", detected: true, configPath: null },
    vars,
    yesMode: true,
    runner: { run: (cmd) => { receivedCmd = cmd; return { ok: true }; } },
  });
  assert.equal(out.kind, "ok");
  assert.match(receivedCmd, /claude mcp add kxta -s user/);
  assert.match(receivedCmd, /KONTEXTA_DATA_DIR=\/tmp\/data/);
  assert.match(receivedCmd, /-- npx -y kontexta-mcp/);
});

test("warns and prints snippet when runner reports failure (e.g. already-configured error from CLI)", () => {
  const out = writeClaudeCode({
    client: { id: "claude-code", label: "Claude Code", strategy: "auto-cli", detected: true, configPath: null },
    vars,
    yesMode: true,
    runner: { run: () => ({ ok: false, error: "server with name 'kxta' already exists" }) },
  });
  assert.equal(out.kind, "warn");
  assert.match(out.message, /already exists|already configured/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-writer-claude-code.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Claude Code writer**

Create `apps/mcp/src/init/writers/claude-code.ts`:

```typescript
import { execSync } from "node:child_process";
import type { ClientStatus, PhaseOutcome } from "../types.js";
import { getSnippet } from "../snippets.js";

export interface Runner {
  run(command: string): { ok: true } | { ok: false; error: string };
}

const defaultRunner: Runner = {
  run(cmd) {
    try {
      execSync(cmd, { stdio: "pipe", timeout: 10_000 });
      return { ok: true };
    } catch (e: any) {
      const err = e?.stderr?.toString?.() || e?.message || String(e);
      return { ok: false, error: err };
    }
  },
};

interface Args {
  client: ClientStatus;
  vars: { dataDir: string; version: string; sourceEntrypoint: string };
  yesMode: boolean;
  runner?: Runner;
}

export function writeClaudeCode(opts: Args): PhaseOutcome {
  const { client, vars, runner = defaultRunner } = opts;
  const cmd = `claude mcp add kxta -s user -e KONTEXTA_DATA_DIR=${vars.dataDir} -- npx -y kontexta-mcp`;
  const result = runner.run(cmd);

  if (result.ok) {
    return { kind: "ok", message: `${client.label} configured via \`claude mcp add\`` };
  }

  // Detect "already exists" — Claude CLI returns this when re-running
  if (/already exists/i.test(result.error)) {
    return {
      kind: "warn",
      message: `${client.label}: server 'kxta' already exists (already configured). To replace, run: claude mcp remove kxta -s user`,
    };
  }

  // Fall back to copy-paste
  const snippet = getSnippet(client.id, "npm", vars);
  return {
    kind: "warn",
    message: `${client.label}: auto-config failed (${result.error.split("\n")[0]}); printing snippet`,
    snippet: snippet.body,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-writer-claude-code.test.mjs`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/init/writers/claude-code.ts apps/mcp/tests/init-writer-claude-code.test.mjs
git commit -m "feat(mcp/init): Claude Code writer via 'claude mcp add'"
```

---

## Task 10: Writers dispatch

**Files:**
- Create: `apps/mcp/src/init/writers/index.ts`

- [ ] **Step 1: Implement dispatch**

Create `apps/mcp/src/init/writers/index.ts`:

```typescript
import type { ClientStatus, InitContext, PhaseOutcome } from "../types.js";
import { writeClaudeCode } from "./claude-code.js";
import { writeJsonMerge } from "./json-merge.js";
import { writeContinue } from "./continue.js";
import { writeCopyPaste } from "./copy-paste.js";

export interface Vars {
  dataDir: string;
  version: string;
  sourceEntrypoint: string;
}

export function dispatchWriter(
  client: ClientStatus,
  ctx: InitContext,
  vars: Vars,
  overwriteApproved?: boolean,
): PhaseOutcome {
  switch (client.strategy) {
    case "auto-cli":
      return writeClaudeCode({ client, vars, yesMode: ctx.args.yes });
    case "auto-json-merge":
      return writeJsonMerge({ client, vars, yesMode: ctx.args.yes, overwriteApproved });
    case "auto-file-write":
      return writeContinue({ client, vars, yesMode: ctx.args.yes, overwriteApproved });
    case "copy-paste":
      return writeCopyPaste({ client, ctx, vars });
  }
}
```

- [ ] **Step 2: Build**

Run: `pnpm --filter kontexta-mcp build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/init/writers/index.ts
git commit -m "feat(mcp/init): writer dispatch by strategy"
```

---

## Task 11: TTY-aware prompts wrapper

**Files:**
- Create: `apps/mcp/src/init/prompts.ts`

- [ ] **Step 1: Implement the wrappers**

Create `apps/mcp/src/init/prompts.ts`:

```typescript
import * as clack from "@clack/prompts";
import type { ClientStatus } from "./types.js";

export interface Prompts {
  text(message: string, defaultValue?: string): Promise<string | null>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  multiselect(
    message: string,
    options: Array<{ value: string; label: string; hint?: string }>,
    initialSelected: string[],
  ): Promise<string[] | null>;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  intro(message: string): void;
  outro(message: string): void;
}

function isCancelled(v: unknown): boolean {
  return clack.isCancel(v);
}

export const interactivePrompts: Prompts = {
  async text(message, defaultValue) {
    const v = await clack.text({ message, placeholder: defaultValue, defaultValue });
    if (isCancelled(v)) return null;
    return typeof v === "string" ? v : null;
  },
  async confirm(message, initial = true) {
    const v = await clack.confirm({ message, initialValue: initial });
    if (isCancelled(v)) return false;
    return v === true;
  },
  async multiselect(message, options, initialSelected) {
    const v = await clack.multiselect({
      message,
      options,
      initialValues: initialSelected,
      required: false,
    });
    if (isCancelled(v)) return null;
    return Array.isArray(v) ? (v as string[]) : null;
  },
  info: (m) => clack.log.info(m),
  success: (m) => clack.log.success(m),
  warn: (m) => clack.log.warn(m),
  error: (m) => clack.log.error(m),
  intro: (m) => clack.intro(m),
  outro: (m) => clack.outro(m),
};

/**
 * Non-interactive prompt impl used in --yes mode and non-TTY environments.
 * All prompts return their "default" or null; errors come from missing required input.
 */
export function nonInteractivePrompts(): Prompts {
  return {
    async text(_m, defaultValue) {
      return defaultValue ?? null;
    },
    async confirm(_m, initial = true) {
      return initial;
    },
    async multiselect(_m, _options, initialSelected) {
      return initialSelected;
    },
    info: (m) => console.log(`  ${m}`),
    success: (m) => console.log(`✓ ${m}`),
    warn: (m) => console.warn(`⚠ ${m}`),
    error: (m) => console.error(`✗ ${m}`),
    intro: (m) => console.log(`\n${m}`),
    outro: (m) => console.log(`\n${m}\n`),
  };
}

export function formatClientChoice(c: ClientStatus): { value: string; label: string; hint?: string } {
  const hint = c.detected
    ? c.strategy === "copy-paste" ? "copy-paste required" : "auto-write"
    : "not detected";
  return { value: c.id, label: c.label, hint };
}
```

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter kontexta-mcp build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/init/prompts.ts
git commit -m "feat(mcp/init): TTY-aware prompts wrapper using @clack/prompts"
```

---

## Task 12: Flow orchestrator (TDD)

**Files:**
- Create: `apps/mcp/src/init/flow.ts`
- Test: `apps/mcp/tests/init-flow.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp/tests/init-flow.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitFlow } from "../dist/init/flow.js";

function makeCtx(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "kontexta-flow-"));
  const dataDir = mkdtempSync(join(tmpdir(), "kontexta-flow-data-"));
  return {
    home,
    dataDir,
    cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); },
    ctx: {
      args: { noProject: true, noClients: true, yes: true, dataDir, ...overrides.args },
      isTTY: false,
      cwd: home,
      platform: "linux",
      env: { HOME: home },
      homeDir: home,
      ...overrides,
    },
  };
}

test("exit code 0 when all phases succeed (noClients + noProject)", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const result = await runInitFlow(ctx);
    assert.equal(result.exitCode, 0);
  } finally { cleanup(); }
});

test("exit code 2 when at least one client write returns warn", async () => {
  const { home, dataDir, cleanup } = makeCtx();
  try {
    // Pre-create a Cursor config that conflicts with what we'd write
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { kxta: { command: "old" } } }));
    const ctx = {
      args: { noProject: true, noClients: false, yes: true, clients: ["cursor"], dataDir },
      isTTY: false, cwd: home, platform: "linux", env: { HOME: home }, homeDir: home,
    };
    const result = await runInitFlow(ctx);
    assert.equal(result.exitCode, 2);
  } finally { cleanup(); }
});

test("project phase: registers when --project given", async () => {
  const { home, dataDir, cleanup } = makeCtx();
  try {
    const projDir = mkdtempSync(join(tmpdir(), "kontexta-proj-"));
    const ctx = {
      args: { project: projDir, noProject: false, noClients: true, yes: true, dataDir },
      isTTY: false, cwd: home, platform: "linux", env: { HOME: home }, homeDir: home,
    };
    const result = await runInitFlow(ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.phases.find((p) => p.phase === "project")?.outcome.kind === "ok");
    rmSync(projDir, { recursive: true, force: true });
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-flow.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the flow**

Create `apps/mcp/src/init/flow.ts`:

```typescript
import { mkdirSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { createDatabase, registerProject, getDbPath, ensureDataDir } from "kxta-core";
import { detectClients } from "./detect.js";
import { dispatchWriter, type Vars } from "./writers/index.js";
import { nonInteractivePrompts, interactivePrompts, formatClientChoice, type Prompts } from "./prompts.js";
import type { InitContext, PhaseOutcome, ClientStatus } from "./types.js";
import type { Client } from "kxta-core";

export interface PhaseResult {
  phase: "data-dir" | "project" | "detect" | "clients" | "hint";
  outcome: PhaseOutcome;
}

export interface FlowResult {
  exitCode: 0 | 1 | 2 | 3;
  phases: PhaseResult[];
}

function pickPrompts(ctx: InitContext): Prompts {
  if (ctx.args.yes || !ctx.isTTY) return nonInteractivePrompts();
  return interactivePrompts;
}

async function phaseDataDir(ctx: InitContext): Promise<PhaseResult> {
  // If --data-dir was passed, surface it via env so all core helpers see it.
  if (ctx.args.dataDir) {
    process.env.KONTEXTA_DATA_DIR = ctx.args.dataDir;
  }
  try {
    ensureDataDir();           // creates the data dir if missing (resolves from env/OS default)
    createDatabase(getDbPath()); // initializes SQLite at the resolved path
    return { phase: "data-dir", outcome: { kind: "ok", message: `Data directory ready: ${getDbPath()}` } };
  } catch (e: any) {
    return { phase: "data-dir", outcome: { kind: "error", message: `Data dir init failed: ${e.message}` } };
  }
}

async function phaseProject(ctx: InitContext, prompts: Prompts): Promise<PhaseResult> {
  if (ctx.args.noProject) {
    return { phase: "project", outcome: { kind: "skipped", message: "Project registration skipped" } };
  }
  let path = ctx.args.project;
  if (!path) {
    const def = existsSync(`${ctx.cwd}/.git`) ? ctx.cwd : undefined;
    const answer = await prompts.text("Path to your first project? (enter to skip)", def);
    if (!answer) {
      return { phase: "project", outcome: { kind: "skipped", message: "No project path provided" } };
    }
    path = answer;
  }
  if (!existsSync(path)) {
    return { phase: "project", outcome: { kind: "error", message: `Project path does not exist: ${path}` } };
  }
  try {
    const name = basename(path);
    registerProject(name, path);
    return { phase: "project", outcome: { kind: "ok", message: `Registered project: ${name} at ${path}` } };
  } catch (e: any) {
    if (/already.*registered/i.test(e.message)) {
      return { phase: "project", outcome: { kind: "ok", message: `Project already registered: ${path}` } };
    }
    return { phase: "project", outcome: { kind: "error", message: `Register failed: ${e.message}` } };
  }
}

async function phaseClients(ctx: InitContext, prompts: Prompts, vars: Vars): Promise<PhaseResult[]> {
  if (ctx.args.noClients) {
    return [{ phase: "clients", outcome: { kind: "skipped", message: "Client configuration skipped" } }];
  }
  const detected = detectClients(ctx);
  let chosen: ClientStatus[];

  if (ctx.args.clients?.length) {
    const set = new Set<Client>(ctx.args.clients);
    chosen = detected.filter((c) => set.has(c.id));
  } else if (!ctx.isTTY || ctx.args.yes) {
    chosen = detected.filter((c) => c.detected && c.strategy !== "copy-paste");
  } else {
    const initial = detected.filter((c) => c.detected && c.strategy !== "copy-paste").map((c) => c.id);
    const ids = await prompts.multiselect(
      "Detected MCP clients — pick which to configure:",
      detected.map(formatClientChoice),
      initial,
    );
    if (!ids) return [{ phase: "clients", outcome: { kind: "skipped", message: "Client selection cancelled" } }];
    chosen = detected.filter((c) => ids.includes(c.id));
  }

  if (chosen.length === 0) {
    return [{ phase: "clients", outcome: { kind: "skipped", message: "No clients selected" } }];
  }

  const results: PhaseResult[] = [];
  for (const client of chosen) {
    const outcome = dispatchWriter(client, ctx, vars);
    results.push({ phase: "clients", outcome });
    if (outcome.snippet) {
      prompts.info(outcome.snippet);
    }
    if (outcome.kind === "ok") prompts.success(outcome.message);
    else if (outcome.kind === "skipped") prompts.info(outcome.message);
    else if (outcome.kind === "warn") prompts.warn(outcome.message);
    else prompts.error(outcome.message);
  }
  return results;
}

function aggregateExitCode(results: PhaseResult[]): 0 | 2 | 3 {
  if (results.some((r) => r.outcome.kind === "error" && r.phase === "data-dir")) return 3;
  if (results.some((r) => r.outcome.kind === "warn" || r.outcome.kind === "error")) return 2;
  return 0;
}

export async function runInitFlow(ctx: InitContext): Promise<FlowResult> {
  const prompts = pickPrompts(ctx);
  prompts.intro("kontexta init");

  const phases: PhaseResult[] = [];
  const dataDirResult = await phaseDataDir(ctx);
  phases.push(dataDirResult);
  if (dataDirResult.outcome.kind === "ok") prompts.success(dataDirResult.outcome.message);
  else prompts.error(dataDirResult.outcome.message);

  if (dataDirResult.outcome.kind === "error") {
    return { exitCode: 3, phases };
  }

  const projectResult = await phaseProject(ctx, prompts);
  phases.push(projectResult);
  if (projectResult.outcome.kind === "ok") prompts.success(projectResult.outcome.message);
  else if (projectResult.outcome.kind === "skipped") prompts.info(projectResult.outcome.message);
  else prompts.warn(projectResult.outcome.message);

  const vars: Vars = {
    dataDir: ctx.args.dataDir ?? ctx.env.KONTEXTA_DATA_DIR ?? "",
    version: "latest",
    sourceEntrypoint: "",
  };
  const clientResults = await phaseClients(ctx, prompts, vars);
  phases.push(...clientResults);

  prompts.outro("Setup complete. Try /mcp in Claude Code, or run `docker compose up -d` for the dashboard.");

  return { exitCode: aggregateExitCode(phases), phases };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-flow.test.mjs`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/src/init/flow.ts apps/mcp/tests/init-flow.test.mjs
git commit -m "feat(mcp/init): five-phase flow orchestrator"
```

---

## Task 13: Init entry point

**Files:**
- Create: `apps/mcp/src/init/index.ts`

- [ ] **Step 1: Implement entry**

Create `apps/mcp/src/init/index.ts`:

```typescript
import { homedir } from "node:os";
import { parseInitArgs } from "./args.js";
import { runInitFlow } from "./flow.js";
import type { InitContext } from "./types.js";

export async function runInit(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseInitArgs(argv);
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    return 3;
  }

  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!isTTY && !args.yes) {
    console.error("✗ Non-interactive environment detected. Pass --yes plus required flags (e.g. --project <path> --clients claude-code).");
    return 3;
  }

  const ctx: InitContext = {
    args,
    isTTY,
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  };

  const result = await runInitFlow(ctx);
  return result.exitCode;
}
```

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter kontexta-mcp build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/src/init/index.ts
git commit -m "feat(mcp/init): entry point with TTY guard"
```

---

## Task 14: Wire CLI router in main entry

**Files:**
- Modify: `apps/mcp/src/index.ts`

- [ ] **Step 1: Add router at top of main()**

Open `apps/mcp/src/index.ts`. Find the existing `main()` function (or the top-level invocation). Add this block before the MCP server startup logic:

```typescript
// CLI router — runs before MCP server startup.
const subcommand = process.argv[2];
if (subcommand === "init") {
  const { runInit } = await import("./init/index.js");
  const exitCode = await runInit(process.argv.slice(3));
  process.exit(exitCode);
}
if (subcommand === "--help" || subcommand === "-h") {
  console.log(`kontexta-mcp [subcommand]

Subcommands:
  init        Configure data dir, register first project, set up MCP clients

When no subcommand is given, kontexta-mcp starts the MCP server on stdio.

Flags for 'init':
  --project <path>     Register this path as the first project
  --no-project         Skip first-project registration
  --clients <list>     Comma-separated client IDs (claude-code,cursor,...)
  --no-clients         Skip client configuration
  --data-dir <path>    Override KONTEXTA_DATA_DIR
  --yes, -y            Accept all defaults; required in non-TTY mode
`);
  process.exit(0);
}
```

If `main()` is currently not async or the file uses top-level await differently, adapt accordingly. Confirm the router block runs before any MCP server initialization.

- [ ] **Step 2: Build**

Run: `pnpm --filter kontexta-mcp build`
Expected: no errors.

- [ ] **Step 3: Smoke test**

Run: `node apps/mcp/dist/index.js --help`
Expected: prints the help text and exits 0.

Run: `node apps/mcp/dist/index.js init --no-project --no-clients --yes`
Expected: prints success messages and exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/src/index.ts
git commit -m "feat(mcp): add CLI subcommand router for init"
```

---

## Task 15: Integration test (end-to-end)

**Files:**
- Create: `apps/mcp/tests/init-integration.test.mjs`

- [ ] **Step 1: Write the integration test**

Create `apps/mcp/tests/init-integration.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("init --yes --no-project --no-clients creates data dir and exits 0", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kontexta-it-"));
  try {
    const res = spawnSync(
      "node",
      ["apps/mcp/dist/index.js", "init", "--yes", "--no-project", "--no-clients", "--data-dir", dataDir],
      { encoding: "utf-8" },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(existsSync(join(dataDir, "kontexta.db")), "DB file should exist");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("init --project <valid-path> registers the project", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kontexta-it-"));
  const project = mkdtempSync(join(tmpdir(), "kontexta-it-proj-"));
  try {
    const res = spawnSync(
      "node",
      ["apps/mcp/dist/index.js", "init", "--yes", "--no-clients", "--data-dir", dataDir, "--project", project],
      { encoding: "utf-8" },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    assert.match(res.stdout, /Registered project/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("init with invalid --clients value exits 3", () => {
  const res = spawnSync(
    "node",
    ["apps/mcp/dist/index.js", "init", "--yes", "--clients", "bogus"],
    { encoding: "utf-8" },
  );
  assert.equal(res.status, 3);
  assert.match(res.stderr, /Unknown client/i);
});

test("init non-TTY without --yes exits 3", () => {
  const res = spawnSync(
    "node",
    ["apps/mcp/dist/index.js", "init"],
    { encoding: "utf-8", input: "" },
  );
  assert.equal(res.status, 3);
  assert.match(res.stderr, /Non-interactive|--yes/i);
});
```

- [ ] **Step 2: Build and run**

Run: `pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/init-integration.test.mjs`
Expected: all 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mcp/tests/init-integration.test.mjs
git commit -m "test(mcp/init): end-to-end integration tests via spawnSync"
```

---

## Task 16: Path verification pass (research, no code)

**Files:** None. This is a verification gate.

Goal: confirm every config path in `apps/mcp/src/init/detect.ts` matches the *current* (2026) docs for that client. The existing web `install-templates.ts` has known stale paths; this task ensures the CLI does not inherit them.

- [ ] **Step 1: Verify each path against current vendor docs**

For each of: Claude Desktop, Cursor, Codex, Gemini, Antigravity, Continue, Aider — open the official docs page and confirm the config file path on macOS / Linux / Windows.

Record findings in a comment block at the top of `apps/mcp/src/init/detect.ts` with the URL + date checked:

```typescript
// Path verification (last checked YYYY-MM-DD):
// - Claude Desktop: https://docs.anthropic.com/.../desktop-extensions ✓ paths match
// - Cursor:         https://docs.cursor.com/.../mcp ✓ paths match
// - Codex:          https://platform.openai.com/.../codex ✓ paths match (TOML, copy-paste only)
// - Gemini:         https://github.com/google/gemini-cli ✓ paths match
// - Antigravity:    <url> ✓ or → update DESCRIPTORS entry
// - Continue:       https://docs.continue.dev ✓
// - Aider:          https://aider.chat/docs ✓ (file-based config, not MCP)
```

If a path differs, update the `resolvePath` function for that descriptor and re-run `apps/mcp/tests/init-detect.test.mjs` to confirm tests still pass (update test fixtures if needed).

- [ ] **Step 2: Commit the verification record (and any path updates)**

```bash
git add apps/mcp/src/init/detect.ts apps/mcp/tests/init-detect.test.mjs
git commit -m "chore(mcp/init): verify MCP client config paths against current docs"
```

---

## Task 17: Documentation

**Files:**
- Modify: `apps/mcp/README.md`
- Modify: `README.md` (root)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update apps/mcp/README.md**

Add a new section after the install instructions:

```markdown
## Quick Setup with `init`

After installing, run the guided setup:

```bash
npx kontexta-mcp init
```

This will:
1. Create the data directory (or use `KONTEXTA_DATA_DIR` if set).
2. Prompt for the path to your first project and register it.
3. Detect installed MCP clients and configure them automatically (Claude Code, Cursor, Continue, Claude Desktop, Antigravity).
4. For clients that require manual config (Codex, Gemini, Aider), print the snippet and target path.

**Flags:**
- `--project <path>` — register this path; skip the prompt
- `--no-project` — skip project registration
- `--clients <ids>` — comma-separated, e.g. `claude-code,cursor`
- `--no-clients` — skip client configuration
- `--data-dir <path>` — override `KONTEXTA_DATA_DIR`
- `--yes`, `-y` — accept all defaults; required in non-TTY environments

**Re-runnable:** safe to run again; idempotent per phase.
\`\`\`
```

- [ ] **Step 2: Update root README.md Quick Start**

In `README.md`, replace the contents of the `### 1. Run the MCP Server (No Install)` section's body with:

```markdown
The fastest way to try Kontexta is via `npx`. First, run the one-time setup:

\`\`\`bash
npx kontexta-mcp init
\`\`\`

This creates the data directory, registers your first project, and wires up any installed MCP clients (Claude Code, Cursor, Continue, etc.). For details on flags and supported clients, see [`apps/mcp/README.md`](apps/mcp/README.md#quick-setup-with-init).

For manual configuration, add this to your MCP client's config file (paths vary by client):

\`\`\`json
{
  "mcpServers": {
    "kxta": {
      "command": "npx",
      "args": ["-y", "kontexta-mcp"],
      "env": {
        "KONTEXTA_DATA_DIR": "/absolute/path/to/your/knowledge-vault"
      }
    }
  }
}
\`\`\`
```

- [ ] **Step 3: Update CHANGELOG.md**

Add a new entry at the top following the existing format:

```markdown
## [Unreleased]

### Added
- `kontexta-mcp init` CLI subcommand: guided first-run setup that creates the data dir, registers a first project, and configures detected MCP clients (Claude Code, Cursor, Continue, Claude Desktop, Antigravity). Copy-paste fallback for Codex, Gemini, Aider. See `apps/mcp/README.md#quick-setup-with-init`.
```

- [ ] **Step 4: Commit**

```bash
git add apps/mcp/README.md README.md CHANGELOG.md
git commit -m "docs: document kontexta-mcp init subcommand"
```

---

## Done

All tasks complete. Verify the full test suite still passes:

```bash
pnpm --filter kontexta-mcp build && node --test apps/mcp/tests/
```

Expected: all init tests pass, all existing tests pass.
