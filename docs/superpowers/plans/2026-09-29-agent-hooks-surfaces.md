# Agent Hooks — Surfaces Implementation Plan (Part B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the hooks backbone in front of users: enable/disable agents in the dashboard (first-run wizard, Configure → Agents tab, alert banner, filtered configure section) and through MCP onboarding prompts, with install triggered by enabling an agent.

**Architecture:** A small core layer (`install-mode`, `alerts`, `--host-data-dir`/`--no-db` for the Docker host path) feeds three thin surfaces that all read the same `agents` table: Next.js API routes + React components, and the MCP server's `projects_register` / `admin_onboard_agent` / session-context responses. No new MCP tool is added (surface stays at 58).

**Tech Stack:** TypeScript, Next.js 15 route handlers, React 19 + Testing Library (jsdom), vitest (core/web/cli), node:test (mcp).

**Spec:** `docs/superpowers/specs/2026-09-29-agent-hooks-design.md` §7–§9. Part A (backbone) is `docs/superpowers/plans/2026-09-29-agent-hooks-backbone.md` and is already implemented in the working tree.

## Global Constraints

- Every agent seeds `enabled = 0`. Disabled agents never appear in alerts, banners, MCP prompts, the configure section's client list, or wizard hook steps.
- Enabling an agent installs its hooks immediately in `npm`/`source` mode. In `docker` mode nothing on the host is ever written by the container: the API/MCP return a copyable `docker run …` command instead.
- All `/api/agents*` routes call `checkAuth(req)` first and return `401` when it fails; agent ids from the URL are validated with `isAgentId` before any DB or filesystem access.
- MCP tool count stays 58: no new tools; `admin_onboard_agent` gains an optional `hooks: boolean` parameter only.
- MCP responses carry a `hooks` block **only when it has alerts to show** (no token bloat when there is nothing to do).
- One-line comments only. No `Co-Authored-By` trailers. Never push. Do not commit unless the user asks (the tree already holds uncommitted Phase 1 / theme / Part A work).
- Repo test conventions: core tests `packages/core/tests/**` (vitest); web tests colocated `*.test.ts(x)` (vitest; components need `// @vitest-environment jsdom`; `tests/setup.ts` gives each test a temp `KONTEXTA_DATA_DIR`/`KONTEXTA_DB_PATH`); mcp tests `apps/mcp/tests/*.test.mjs` (node:test against `dist/`); cli tests `packages/cli/tests/*.test.ts`.
- Web tests must never touch the real home directory: install routes read `process.env.KONTEXTA_HOOKS_HOME` (temp dir in tests) instead of `os.homedir()`.

## Review Focus

1. Enabling an agent whose config file is malformed → `PATCH` still returns 200 with `install.ok:false` and the error text; the agent stays enabled; the file is untouched; the UI shows the error instead of crashing. *(Task 4, test "malformed config")*
2. Docker mode never writes host files, and a hostile `:id` (`../etc`, shell metacharacters) can't reach the DB, filesystem or a generated command. *(Task 4, tests "docker mode" and "unknown id")*
3. Unauthenticated or invalid requests (`401`, `400`, `404`) have no side effects: no `enabled` flip, no file written. *(Task 4, tests "401" and "invalid body")*
4. The configure section fails open (all clients listed) when `/api/agents` errors or returns an unexpected shape, and shows only `generic` plus a hint when no agent is enabled. *(Task 8)*
5. MCP: no `hooks` key when nothing needs attention; `hooks:true` without `target_agent` errors **before** any file is written; `hooks:true` for an agent with no hook API returns a note, not an exception. *(Task 9)*

---

### Task 1: Emitter version becomes a content hash

Part A set `EMITTER_VERSION = RULE_BLOCK_VERSION`, but that value is `rulesVersion` (3.0.0) and only moves when the rules block changes — so editing `emit.mjs` never triggers a re-stage. Derive the version from the emitter's own content instead.

**Files:**
- Modify: `packages/core/src/hooks/stage.ts`
- Modify: `packages/core/tests/hooks/stage.test.ts:1-20`

**Interfaces:**
- Produces: `emitterVersionOf(source: string): string` (first 12 hex chars of sha256); `EMITTER_VERSION: string` now equals `emitterVersionOf(<dev emit.mjs source>)` or `"unknown"` when the source can't be read. All existing consumers (`install.ts`, `hooks-cli`, tests) keep importing `EMITTER_VERSION` unchanged.

- [ ] **Step 1: Write the failing test**

In `packages/core/tests/hooks/stage.test.ts`: remove the `RULE_BLOCK_VERSION` import, add `emitterVersionOf` to the `stage.js` import list, and replace the first test (`"EMITTER_VERSION is the core package version"`) with:
```ts
  it("EMITTER_VERSION is a content hash of emit.mjs, so any emitter change changes it", () => {
    const src = readFileSync(emitterSourcePath(), "utf8");
    expect(EMITTER_VERSION).toBe(emitterVersionOf(src));
    expect(EMITTER_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(emitterVersionOf(src + "\n// changed")).not.toBe(EMITTER_VERSION);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/hooks/stage.test.ts`
Expected: FAIL — `emitterVersionOf` is not exported (and the old constant is `3.0.0`, not 12 hex chars).

- [ ] **Step 3: Implement**

In `packages/core/src/hooks/stage.ts`: delete `import { RULE_BLOCK_VERSION } from "../agent-rules/index.js";`, add `import { createHash } from "node:crypto";`, and replace the `EMITTER_VERSION` line with:
```ts
export function emitterVersionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

// Content-derived so any emit.mjs change re-stages on the next reconcile; rulesVersion only moves when the rules block changes.
export const EMITTER_VERSION: string = (() => {
  try { return emitterVersionOf(readFileSync(emitterSourcePath(), "utf8")); } catch { return "unknown"; }
})();
```
Export `emitterVersionOf` from `packages/core/src/hooks/index.ts` (add it to the `./stage.js` export list).

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/hooks/`
Expected: all PASS (install/reconcile tests reference `EMITTER_VERSION` symbolically, so they follow the new value).

---

### Task 2: `onboardable` flag, install-mode detection, hooks block builder

**Files:**
- Modify: `packages/core/src/hooks/agents.ts`
- Modify: `packages/core/src/hooks/registry.ts` (add `onboardable` to `AgentRow` and `listAgents`)
- Create: `packages/core/src/hooks/install-mode.ts`
- Create: `packages/core/src/hooks/alerts.ts`
- Modify: `packages/core/src/hooks/index.ts`
- Test: `packages/core/tests/hooks/alerts.test.ts`, `packages/core/tests/hooks/agents.test.ts`

**Interfaces:**
- Produces:
```ts
type InstallMode = "docker" | "npm" | "source"
function detectInstallMode(env?: NodeJS.ProcessEnv, fileExists?: (p: string) => boolean): InstallMode
function dockerInstallCommand(o: { agent: string; version: string; hostDataDir?: string | null }): string
interface HooksAlert { agent: string; name: string; installed: boolean; verified_at: string | null; docker_command?: string }
interface HooksBlock { install_mode: InstallMode; alerts: HooksAlert[]; prompt: string | null }
function buildHooksBlock(o: { installMode: InstallMode; version: string; hostDataDir?: string | null; now?: Date }): HooksBlock
AgentMeta.onboardable: boolean   // true exactly for agents that have a rules-file scaffold
AgentRow.onboardable: boolean
```
- Consumes: `alerts(now)` from `registry.ts` (Part A).

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/hooks/agents.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AGENTS } from "../../src/hooks/agents.js";
import { SCAFFOLDS } from "../../src/agent-rules/index.js";

describe("AGENTS.onboardable", () => {
  it("is true exactly for agents that have a rules-file scaffold", () => {
    const onboardable = AGENTS.filter((a) => a.onboardable).map((a) => a.id).sort();
    expect(onboardable).toEqual(Object.keys(SCAFFOLDS).sort());
  });
});
```
`packages/core/tests/hooks/alerts.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { syncAgentRows, setEnabled, markInstalled } from "../../src/hooks/registry.js";
import { detectInstallMode } from "../../src/hooks/install-mode.js";
import { dockerInstallCommand, buildHooksBlock } from "../../src/hooks/alerts.js";

describe("detectInstallMode", () => {
  const no = () => false;
  it("prefers KONTEXTA_INSTALL_HINT", () => {
    expect(detectInstallMode({ KONTEXTA_INSTALL_HINT: "docker" }, no)).toBe("docker");
    expect(detectInstallMode({ KONTEXTA_INSTALL_HINT: "npm" }, () => true)).toBe("npm");
    expect(detectInstallMode({ KONTEXTA_INSTALL_HINT: "source" }, () => true)).toBe("source");
  });
  it("falls back to /.dockerenv, then npx, then source", () => {
    expect(detectInstallMode({}, (p) => p === "/.dockerenv")).toBe("docker");
    expect(detectInstallMode({ npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js" }, no)).toBe("npm");
    expect(detectInstallMode({}, no)).toBe("source");
  });
});

describe("dockerInstallCommand", () => {
  it("builds the host-side install one-liner with a placeholder when the host dir is unknown", () => {
    const c = dockerInstallCommand({ agent: "gemini", version: "5.0.0", hostDataDir: null });
    expect(c).toContain('-v "$HOME":/host');
    expect(c).toContain('-v "<DATA_DIR>":/app/data');
    expect(c).toContain("safiyu/kontexta:5.0.0 hooks install");
    expect(c).toContain("--home /host");
    expect(c).toContain('--host-data-dir "<DATA_DIR>"');
    expect(c).toContain("--no-db");
    expect(c.endsWith("--agent gemini")).toBe(true);
  });
  it("uses the real host dir when known", () => {
    expect(dockerInstallCommand({ agent: "cursor", version: "5.0.0", hostDataDir: "/srv/kx" })).toContain('-v "/srv/kx":/app/data');
  });
});

describe("buildHooksBlock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kontexta-alerts-")); createDatabase(join(dir, "t.db")); syncAgentRows(); });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  it("has no alerts and no prompt when nothing is enabled", () => {
    expect(buildHooksBlock({ installMode: "npm", version: "5.0.0" })).toEqual({ install_mode: "npm", alerts: [], prompt: null });
  });

  it("never mentions disabled or unsupported agents", () => {
    setEnabled("aider", true);
    expect(buildHooksBlock({ installMode: "npm", version: "5.0.0" }).alerts).toEqual([]);
  });

  it("npm mode: alerts enabled-but-missing agents and tells the agent how to install", () => {
    setEnabled("claude-code", true);
    setEnabled("gemini", true); markInstalled("gemini", "x");
    const b = buildHooksBlock({ installMode: "npm", version: "5.0.0" });
    expect(b.alerts.map((a) => a.agent)).toEqual(["claude-code"]);
    expect(b.alerts[0]).toMatchObject({ name: "Claude Code", installed: false, verified_at: null });
    expect(b.alerts[0].docker_command).toBeUndefined();
    expect(b.prompt).toContain("Claude Code");
    expect(b.prompt).toContain("admin_onboard_agent");
    expect(b.prompt).toContain("hooks:true");
  });

  it("docker mode: attaches a docker_command to every alert and does not suggest onboard_agent", () => {
    setEnabled("codex", true);
    const b = buildHooksBlock({ installMode: "docker", version: "5.0.0", hostDataDir: "/srv/kx" });
    expect(b.alerts[0].docker_command).toContain("--agent codex");
    expect(b.prompt).toContain("docker");
    expect(b.prompt).not.toContain("admin_onboard_agent");
  });

  it("installed-but-silent agents get a distinct 'no events' message", () => {
    setEnabled("cursor", true); markInstalled("cursor", "x");
    getDatabase().prepare("UPDATE agents SET hooks_installed_at = '2026-09-01T00:00:00.000Z' WHERE id = 'cursor'").run();
    const b = buildHooksBlock({ installMode: "npm", version: "5.0.0", now: new Date("2026-09-29T00:00:00Z") });
    expect(b.alerts[0]).toMatchObject({ agent: "cursor", installed: true });
    expect(b.prompt).toMatch(/installed but no events/i);
    expect(b.prompt).toContain("kontexta hooks status");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/core && npx vitest run tests/hooks/agents.test.ts tests/hooks/alerts.test.ts`
Expected: FAIL — `a.onboardable` undefined; `install-mode.js` / `alerts.js` not found.

- [ ] **Step 3: Implement `agents.ts` and `registry.ts`**

`packages/core/src/hooks/agents.ts` — add `onboardable: boolean` to `AgentMeta`, add the field to every `AGENTS` entry (`true` for claude-code, codex, gemini, copilot, cursor, cline, antigravity, continue, aider, generic; `false` for windsurf, kiro, opencode, claude-desktop, hermes), and widen the `satisfies` clause to `{ id: string; name: string; hooksSupported: boolean; onboardable: boolean }`.
`packages/core/src/hooks/registry.ts` — add `onboardable: boolean;` to `AgentRow` and `onboardable: a.onboardable,` to the object built in `listAgents()`.

- [ ] **Step 4: Implement `install-mode.ts` and `alerts.ts`**

`packages/core/src/hooks/install-mode.ts`:
```ts
import { existsSync } from "node:fs";

export type InstallMode = "docker" | "npm" | "source";

export function detectInstallMode(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): InstallMode {
  const hint = env.KONTEXTA_INSTALL_HINT;
  if (hint === "docker" || hint === "npm" || hint === "source") return hint;
  try { if (fileExists("/.dockerenv")) return "docker"; } catch { /* unreadable root fs → keep probing */ }
  if (env.npm_execpath?.includes("npx")) return "npm";
  return "source";
}
```
`packages/core/src/hooks/alerts.ts`:
```ts
import { alerts as registryAlerts } from "./registry.js";
import type { InstallMode } from "./install-mode.js";

export interface HooksAlert { agent: string; name: string; installed: boolean; verified_at: string | null; docker_command?: string }
export interface HooksBlock { install_mode: InstallMode; alerts: HooksAlert[]; prompt: string | null }

export function dockerInstallCommand(o: { agent: string; version: string; hostDataDir?: string | null }): string {
  const dir = o.hostDataDir && o.hostDataDir.length > 0 ? o.hostDataDir : "<DATA_DIR>";
  return `docker run --rm -v "$HOME":/host -v "${dir}":/app/data safiyu/kontexta:${o.version} hooks install --home /host --host-data-dir "${dir}" --no-db --agent ${o.agent}`;
}

export function buildHooksBlock(o: { installMode: InstallMode; version: string; hostDataDir?: string | null; now?: Date }): HooksBlock {
  const alerts: HooksAlert[] = registryAlerts(o.now).map((r) => ({
    agent: r.id, name: r.name, installed: r.hooks_installed, verified_at: r.hooks_verified_at,
    ...(o.installMode === "docker" ? { docker_command: dockerInstallCommand({ agent: r.id, version: o.version, hostDataDir: o.hostDataDir }) } : {}),
  }));
  if (alerts.length === 0) return { install_mode: o.installMode, alerts, prompt: null };

  const missing = alerts.filter((a) => !a.installed);
  const silent = alerts.filter((a) => a.installed);
  const lines: string[] = [];
  if (missing.length > 0) {
    const names = missing.map((a) => a.name).join(", ");
    lines.push(
      o.installMode === "docker"
        ? `Kontexta can capture your conversation and shell commands for ${names}. The container cannot edit files on your machine, so run the docker command from the dashboard's Configure → AGENTS tab (or hooks.alerts[].docker_command) on the host.`
        : `Kontexta can capture your conversation and shell commands for ${names}. Install their hooks now? After the user agrees, call admin_onboard_agent with hooks:true, confirm:true and target_agent set to one of (${missing.map((a) => a.agent).join(" | ")}), or run \`kontexta hooks install --agent <id>\`.`,
    );
  }
  if (silent.length > 0) {
    lines.push(`Hooks for ${silent.map((a) => a.name).join(", ")} are installed but no events have arrived in over a week — run \`kontexta hooks status\` to check.`);
  }
  return { install_mode: o.installMode, alerts, prompt: lines.join(" ") };
}
```
Append to `packages/core/src/hooks/index.ts`:
```ts
export { detectInstallMode } from "./install-mode.js";
export type { InstallMode } from "./install-mode.js";
export { dockerInstallCommand, buildHooksBlock } from "./alerts.js";
export type { HooksAlert, HooksBlock } from "./alerts.js";
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd packages/core && npx vitest run tests/hooks/`
Expected: all PASS.

---

### Task 3: Host-side Docker install support (`--host-data-dir`, `--no-db`) and verified-counts-as-installed

> **Already applied by the Part A fix pass:** `InstallCtx.hostDataDir`, `hostDirOf`, `nodeCmdOf` (in `installers/json-config.ts`) and the OpenCode plugin's host-path handling. Skip those bullets; everything else below (HooksOpts flags, registry-free install, CLI flags, `alerts()` change, tests) is still to do. Kiro is no longer hook-capable (no installer), so it is not part of any Part B flow.

Part A's Docker one-liner passed `--data-dir <host path>`, which inside the container would make kontexta open a database at a path that doesn't exist there. The container must keep using `/app/data` for staging while writing the **host** path into agent configs, and it must not open the shared SQLite file while the dashboard container has it open.

**Files:**
- Modify: `packages/core/src/hooks/installers/types.ts`, `json-config.ts`, `opencode.ts`
- Modify: `packages/core/src/hooks/install.ts`, `registry.ts` (`alerts`)
- Modify: `apps/mcp/src/hooks-cli.ts`
- Test: `packages/core/tests/hooks/install-host.test.ts`, extend `packages/core/tests/hooks/registry.test.ts`, extend `apps/mcp/tests/hooks-cli.test.mjs`

**Interfaces:**
- Produces: `InstallCtx.hostDataDir?: string`; `HooksOpts.hostDataDir?: string`, `HooksOpts.registry?: boolean` (default `true`; `false` = no DB reads/writes, no projects sidecar sync); CLI flags `--host-data-dir <dir>` and `--no-db` (valid only for `install` / `uninstall`).
- Behavior: paths written **into agent configs** (`emit.mjs` location and `--data-dir` argument) use `hostDataDir ?? dataDir`; staging still writes to `dataDir`.
- `alerts()` no longer alerts on an enabled agent that is not marked installed but has `hooks_verified_at` set (events are arriving, so hooks evidently work — this is how a Docker host install becomes "healthy").

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/hooks/install-host.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase } from "../../src/db/index.js";
import { syncAgentRows, listAgents } from "../../src/hooks/registry.js";
import { installHooks } from "../../src/hooks/install.js";

let home: string; let dataDir: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kx-h-")); dataDir = mkdtempSync(join(tmpdir(), "kx-d-")); });
afterEach(() => { closeDatabase(); rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });

describe("host-side install (docker path)", () => {
  it("writes HOST paths into the agent config but stages the emitter in the container data dir, without touching the DB", () => {
    // Deliberately no createDatabase(): registry:false must not need one.
    const out = installHooks(["gemini", "opencode"], { home, dataDir, hostDataDir: "/host/kx-data", registry: false });
    expect(out.map((o) => o.ok)).toEqual([true, true]);
    expect(existsSync(join(dataDir, "hooks", "emit.mjs"))).toBe(true);
    expect(existsSync(join(dataDir, "hooks", "projects.json"))).toBe(false);
    const cfg = readFileSync(join(home, ".gemini", "settings.json"), "utf8");
    expect(cfg).toContain("/host/kx-data/hooks/emit.mjs");
    expect(cfg).toContain('--data-dir \\"/host/kx-data\\"');
    expect(cfg).not.toContain(dataDir);
    const plugin = readFileSync(join(home, ".config", "opencode", "plugins", "kontexta.ts"), "utf8");
    expect(plugin).toContain('"/host/kx-data/hooks/emit.mjs"');
    expect(plugin).toContain('const DATA_DIR = "/host/kx-data"');
  });

  it("registry:true (default) still marks the DB and defaults host path to dataDir", () => {
    createDatabase(join(dataDir, "k.db")); syncAgentRows();
    installHooks(["gemini"], { home, dataDir });
    expect(listAgents().find((r) => r.id === "gemini")!.hooks_installed).toBe(true);
    expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toContain(join(dataDir, "hooks", "emit.mjs"));
  });
});
```
Append to `packages/core/tests/hooks/registry.test.ts` (inside the `describe`):
```ts
  it("alerts(): an enabled, not-installed agent whose events are arriving is healthy", () => {
    syncAgentRows();
    setEnabled("gemini", true);
    markVerified("gemini", "2026-09-29T10:00:00.000Z");
    expect(alerts(new Date("2026-09-29T12:00:00.000Z"))).toEqual([]);
  });
```
Append to `apps/mcp/tests/hooks-cli.test.mjs`:
```js
test("hooks-cli: --no-db --host-data-dir writes host paths and never creates a database", () => {
  const home = mkdtempSync(join(tmpdir(), "kx-home-"));
  const data = mkdtempSync(join(tmpdir(), "kx-data-"));
  const env = { HOME: home, KONTEXTA_DATA_DIR: data };
  try {
    const r = run(["install", "--agent", "cursor", "--home", home, "--host-data-dir", "/host/kx", "--no-db"], env);
    assert.equal(r.code, 0, r.err);
    const cfg = readFileSync(join(home, ".cursor", "hooks.json"), "utf8");
    assert.ok(cfg.includes("/host/kx/hooks/emit.mjs"));
    assert.ok(existsSync(join(data, "hooks", "emit.mjs")));
    assert.ok(!existsSync(join(data, "kontexta.db")));
    assert.equal(run(["status", "--no-db"], env).code, 2);
    assert.equal(run(["install", "--all-enabled", "--no-db"], env).code, 2);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/core && npx vitest run tests/hooks/install-host.test.ts tests/hooks/registry.test.ts`
Expected: FAIL — `hostDataDir`/`registry` options ignored (config contains the container path; `createDatabase` missing throws).

- [ ] **Step 3: Implement (core)**

`installers/types.ts` — add `hostDataDir?: string;` to `InstallCtx`.
`installers/json-config.ts` — add and use a helper:
```ts
export const hostDirOf = (ctx: InstallCtx): string => ctx.hostDataDir ?? ctx.dataDir;
```
and in `emitCommand` replace `stagedEmitterPath(ctx.dataDir)` with `stagedEmitterPath(hostDirOf(ctx))` and the `--data-dir` value `q(ctx.dataDir)` with `q(hostDirOf(ctx))`.
`installers/opencode.ts` — import `hostDirOf` from `./json-config.js`; in `pluginSource` use `stagedEmitterPath(hostDirOf(ctx))` and `JSON.stringify(hostDirOf(ctx))` for `dataDir`.
`install.ts`:
- `HooksOpts` gains `hostDataDir?: string; registry?: boolean;`
- `ctxOf` passes `hostDataDir: opts.hostDataDir`.
- In `installHooks`: `const registry = opts.registry !== false;` stage the emitter always (`stageEmitter(ctx.dataDir)`) but call `syncProjectsSidecar` only when `registry`; call `markInstalled` only when `registry`.
- In `uninstallHooks`: call `markUninstalled` only when `opts.registry !== false`.
`registry.ts` — in `alerts()` change the first disjunct to `(!r.hooks_installed && r.hooks_verified_at === null)`.

- [ ] **Step 4: Implement (`hooks-cli.ts`)**

Add `"host-data-dir": { type: "string" }` and `"no-db": { type: "boolean", default: false }` to the `parseArgs` options. Then:
```ts
  const noDb = values["no-db"];
  if (noDb && cmd !== "install" && cmd !== "uninstall") { process.stderr.write(`--no-db only supports install and uninstall\n`); return 2; }
  if (noDb && values["all-enabled"]) { process.stderr.write("--all-enabled needs the database; pass --agent instead\n"); return 2; }
```
placed right after the `cmd` validation; replace the unconditional `getDatabase(); syncAgentRows();` with `if (!noDb) { getDatabase(); syncAgentRows(); }`; add `hostDataDir: values["host-data-dir"], registry: !noDb` to `opts`; and in the `finally` block call `closeDatabase()` only when `!noDb`. Update `USAGE` to list `--host-data-dir <dir>` and `--no-db`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd packages/core && npx vitest run tests/hooks/ && pnpm -C packages/core build && pnpm -C apps/mcp build && cd apps/mcp && node --test tests/hooks-cli.test.mjs`
Expected: all PASS.

---

### Task 4: Web API — `/api/agents`, `/api/agents/[id]`, `/api/agents/[id]/hooks`

**Files:**
- Create: `apps/web/src/lib/app-version.ts`, `apps/web/src/lib/agents-state.ts`
- Create: `apps/web/src/app/api/agents/route.ts`, `apps/web/src/app/api/agents/[id]/route.ts`, `apps/web/src/app/api/agents/[id]/hooks/route.ts`
- Modify: `apps/web/src/app/api/install-snippets/route.ts` (use core's `detectInstallMode`; delete the local `detectInstall`)
- Test: `apps/web/src/app/api/agents/route.test.ts`

**Interfaces:**
- Consumes from `kxta-core`: `hooksStatus`, `buildHooksBlock`, `dockerInstallCommand`, `detectInstallMode`, `installHooks`, `uninstallHooks`, `setEnabled`, `isAgentId`, `agentMeta`, types `HookStatusRow`, `HooksAlert`, `InstallMode`.
- Produces (HTTP):
  - `GET /api/agents` → `{ install_mode, agents: HookStatusRow[], alerts: HooksAlert[], prompt: string|null, docker_commands: Record<agentId, string> }` (`docker_commands` only populated in docker mode).
  - `PATCH /api/agents/:id` body `{ enabled: boolean }` → `{ agent, enabled, install: AgentHookOutcome|null, docker_command: string|null, note: string|null }`.
  - `POST /api/agents/:id/hooks` body `{ action: "install"|"uninstall" }` → `{ agent, outcome }`, or `409 { error, mode:"docker", docker_command }` in docker mode.
- Env: `KONTEXTA_HOOKS_HOME` (home dir override, used by tests), `KONTEXTA_HOST_DATA_DIR` (compose already sets it).

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/api/agents/route.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSetting, getDatabase } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";
import { GET } from "./route";
import { PATCH } from "./[id]/route";
import { POST } from "./[id]/hooks/route";

let home: string;
const get = () => GET(new NextRequest("http://localhost/api/agents"));
const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/agents/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/agents/${id}/hooks`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const enabledInDb = (id: string) => (getDatabase().prepare("SELECT enabled FROM agents WHERE id = ?").get(id) as { enabled: number } | undefined)?.enabled;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kx-agents-home-"));
  process.env.KONTEXTA_HOOKS_HOME = home;
  process.env.KONTEXTA_INSTALL_HINT = "npm";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KONTEXTA_HOOKS_HOME; delete process.env.KONTEXTA_INSTALL_HINT; delete process.env.KONTEXTA_HOST_DATA_DIR;
});

describe("GET /api/agents", () => {
  it("lists every agent disabled with the install mode and no alerts", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.install_mode).toBe("npm");
    expect(j.agents).toHaveLength(15);
    expect(j.agents.every((a: any) => a.enabled === false)).toBe(true);
    expect(j.alerts).toEqual([]);
    expect(j.docker_commands).toEqual({});
  });
});

describe("PATCH /api/agents/:id", () => {
  it("enable installs hooks immediately (npm mode)", async () => {
    const res = await patch("gemini", { enabled: true });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ agent: "gemini", enabled: true, docker_command: null });
    expect(j.install).toMatchObject({ ok: true, changed: true });
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    const state = await (await get()).json();
    const g = state.agents.find((a: any) => a.id === "gemini");
    expect(g).toMatchObject({ enabled: true, hooks_installed: true });
    expect(state.alerts).toEqual([]);
  });

  it("docker mode: never writes host files, returns the docker command", async () => {
    process.env.KONTEXTA_INSTALL_HINT = "docker";
    const j = await (await patch("gemini", { enabled: true })).json();
    expect(j.install).toBeNull();
    expect(j.docker_command).toContain("--agent gemini");
    expect(j.docker_command).toContain("--no-db");
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    const state = await (await get()).json();
    expect(state.docker_commands.gemini).toBe(j.docker_command);
    expect(state.alerts.map((a: any) => a.agent)).toEqual(["gemini"]);
  });

  it("malformed config: 200 with install.ok=false, agent stays enabled, file untouched", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{ broken");
    const res = await patch("gemini", { enabled: true });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.install.ok).toBe(false);
    expect(j.install.error).toMatch(/not valid JSON/);
    expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toBe("{ broken");
    expect(enabledInDb("gemini")).toBe(1);
  });

  it("agents without a hook API enable cleanly with a note and no install", async () => {
    const j = await (await patch("aider", { enabled: true })).json();
    expect(j.install).toBeNull();
    expect(j.note).toMatch(/MCP capture only/);
    expect(enabledInDb("aider")).toBe(1);
  });

  it("disable keeps the hook config in place", async () => {
    await patch("gemini", { enabled: true });
    const j = await (await patch("gemini", { enabled: false })).json();
    expect(j).toMatchObject({ enabled: false, install: null });
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    expect(enabledInDb("gemini")).toBe(0);
  });

  it("unknown id → 404 with no side effects", async () => {
    for (const id of ["nope", "../etc/passwd", "gemini; rm -rf /"]) {
      const res = await patch(id, { enabled: true });
      expect(res.status).toBe(404);
    }
    expect(readdirSafe(home)).toEqual([]);
  });

  it("invalid body → 400 and nothing changes", async () => {
    expect((await patch("gemini", { enabled: "yes" })).status).toBe(400);
    expect((await patch("gemini", "not json")).status).toBe(400);
    expect(enabledInDb("gemini")).toBe(0);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
  });
});

describe("POST /api/agents/:id/hooks", () => {
  it("uninstall removes only kontexta's entries; install re-adds them", async () => {
    await patch("codex", { enabled: true });
    const un = await (await post("codex", { action: "uninstall" })).json();
    expect(un.outcome).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))).toEqual({});
    const re = await (await post("codex", { action: "install" })).json();
    expect(re.outcome).toMatchObject({ ok: true, changed: true });
  });

  it("docker mode → 409 with the command, nothing written", async () => {
    process.env.KONTEXTA_INSTALL_HINT = "docker";
    const res = await post("codex", { action: "install" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.mode).toBe("docker");
    expect(j.docker_command).toContain("--agent codex");
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("rejects unsupported agents, bad actions and unknown ids", async () => {
    expect((await post("aider", { action: "install" })).status).toBe(400);
    expect((await post("codex", { action: "explode" })).status).toBe(400);
    expect((await post("nope", { action: "install" })).status).toBe(404);
  });
});

describe("authentication", () => {
  it("returns 401 on every route once a password is set, with no side effects", async () => {
    ensureDbInitialized();
    setSetting("auth_password_hash", "x");
    expect((await get()).status).toBe(401);
    expect((await patch("gemini", { enabled: true })).status).toBe(401);
    expect((await post("gemini", { action: "install" })).status).toBe(401);
    expect(enabledInDb("gemini")).toBe(0);
    expect(existsSync(join(home, ".gemini"))).toBe(false);
  });
});

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/app/api/agents/route.test.ts`
Expected: FAIL — cannot resolve `./route`, `./[id]/route`, `./[id]/hooks/route`.

- [ ] **Step 3: Implement the helpers**

`apps/web/src/lib/app-version.ts`:
```ts
import pkg from "../../package.json";

export const appVersion = (): string => String(pkg.version ?? "latest");
```
`apps/web/src/lib/agents-state.ts`:
```ts
import { hooksStatus, buildHooksBlock, dockerInstallCommand, detectInstallMode, type HookStatusRow, type HooksAlert, type InstallMode } from "kxta-core";
import { DATA_DIR } from "@/lib/db-init";
import { appVersion } from "@/lib/app-version";

export const hooksHome = (): string | undefined => process.env.KONTEXTA_HOOKS_HOME || undefined;
export const hostDataDir = (): string | null => process.env.KONTEXTA_HOST_DATA_DIR || null;
export const installOpts = () => ({ home: hooksHome(), dataDir: DATA_DIR });
export const dockerCommandFor = (agent: string): string => dockerInstallCommand({ agent, version: appVersion(), hostDataDir: hostDataDir() });

export interface AgentsState {
  install_mode: InstallMode;
  agents: HookStatusRow[];
  alerts: HooksAlert[];
  prompt: string | null;
  docker_commands: Record<string, string>;
}

export function agentsState(): AgentsState {
  const mode = detectInstallMode();
  const agents = hooksStatus(installOpts());
  const block = buildHooksBlock({ installMode: mode, version: appVersion(), hostDataDir: hostDataDir() });
  const docker_commands: Record<string, string> = {};
  if (mode === "docker") for (const a of agents) if (a.hooks_supported) docker_commands[a.id] = dockerCommandFor(a.id);
  return { install_mode: mode, agents, alerts: block.alerts, prompt: block.prompt, docker_commands };
}
```

- [ ] **Step 4: Implement the routes**

`apps/web/src/app/api/agents/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { agentsState } from "@/lib/agents-state";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  return NextResponse.json(agentsState());
}
```
`apps/web/src/app/api/agents/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { isAgentId, agentMeta, setEnabled, installHooks, detectInstallMode } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { installOpts, dockerCommandFor } from "@/lib/agents-state";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  const { id } = await params;
  if (!isAgentId(id)) return NextResponse.json({ error: `Unknown agent: ${id}` }, { status: 404 });

  let body: { enabled?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });

  setEnabled(id, body.enabled);
  const meta = agentMeta(id)!;
  let install = null;
  let docker_command: string | null = null;
  let note: string | null = null;
  if (body.enabled) {
    if (!meta.hooksSupported) note = `${meta.name} has no hook API — MCP capture only.`;
    else if (detectInstallMode() === "docker") docker_command = dockerCommandFor(id);
    else install = installHooks([id], installOpts())[0];
  }
  return NextResponse.json({ agent: id, enabled: body.enabled, install, docker_command, note });
}
```
`apps/web/src/app/api/agents/[id]/hooks/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { isAgentId, agentMeta, installHooks, uninstallHooks, detectInstallMode } from "kxta-core";
import { checkAuth } from "@/lib/auth";
import { ensureDbInitialized } from "@/lib/db-init";
import { installOpts, dockerCommandFor } from "@/lib/agents-state";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  ensureDbInitialized();
  const { id } = await params;
  if (!isAgentId(id)) return NextResponse.json({ error: `Unknown agent: ${id}` }, { status: 404 });

  let body: { action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  const action = body?.action;
  if (action !== "install" && action !== "uninstall") return NextResponse.json({ error: "action must be 'install' or 'uninstall'" }, { status: 400 });
  if (!agentMeta(id)!.hooksSupported) return NextResponse.json({ error: `${id} does not support hooks (MCP capture only)` }, { status: 400 });
  if (detectInstallMode() === "docker") {
    return NextResponse.json({ error: "Hooks live on the host; run the docker command there.", mode: "docker", docker_command: dockerCommandFor(id) }, { status: 409 });
  }
  const [outcome] = action === "install" ? installHooks([id], installOpts()) : uninstallHooks([id], installOpts());
  return NextResponse.json({ agent: id, outcome });
}
```

- [ ] **Step 5: Reuse core's install detection in `install-snippets`**

In `apps/web/src/app/api/install-snippets/route.ts`: add `detectInstallMode` to the existing `import { defaultDataDir, defaultDataDirDisplay } from "kxta-core";`, delete the local `function detectInstall(): Install { … }`, and replace its single call site `detectedInstall: detectInstall(),` with `detectedInstall: detectInstallMode(),`. (Keep the `Install` type import if still referenced elsewhere in the file.)

- [ ] **Step 6: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/app/api/agents/route.test.ts src/app/api/install-snippets && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; typecheck clean.

---

### Task 5: `useAgents` hook, Agents panel, Configure → AGENTS tab

**Files:**
- Create: `apps/web/src/hooks/use-agents.ts`
- Create: `apps/web/src/components/agents/agents-panel.tsx`
- Modify: `apps/web/src/components/docs/docs-modal.tsx`
- Test: `apps/web/src/components/agents/agents-panel.test.tsx`

**Interfaces:**
- Produces:
```ts
interface AgentInfo { id; name; enabled; hooks_supported; onboardable; hooks_installed; hooks_version; hooks_verified_at; last_hook_event_at; config_present; emitter_stale; notes: string[] }
interface AgentsState { install_mode: "docker"|"npm"|"source"; agents: AgentInfo[]; alerts: {agent,name,installed,verified_at}[]; prompt: string|null; docker_commands: Record<string,string> }
interface ToggleResult { agent; enabled; install: { ok; changed; error?; notes: string[] } | null; docker_command: string|null; note: string|null }
function useAgents(): { state: AgentsState|null; loading: boolean; refresh(): Promise<void>; setEnabled(id, enabled): Promise<ToggleResult|null>; hooksAction(id, action): Promise<{ ok: boolean; status: number; outcome?: ToggleResult["install"]; docker_command?: string; error?: string }> }
const AGENTS_CHANGED_EVENT = "kontexta:agents-changed"   // window event; every useAgents instance refreshes on it
type Tab = "tools" | "install" | "agents" | "builder" | "journal"   // DocsModal gains "agents" and an optional `initialTab` prop
```
- `useAgents` only accepts a response whose JSON has an `agents` array; anything else leaves `state` `null` (consumers treat that as "unavailable").

- [ ] **Step 1: Write the failing component test**

`apps/web/src/components/agents/agents-panel.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentsPanel } from "./agents-panel";

const row = (over: Record<string, unknown>) => ({
  id: "claude-code", name: "Claude Code", enabled: false, hooks_supported: true, onboardable: true, hooks_installed: false,
  hooks_version: null, hooks_verified_at: null, last_hook_event_at: null, config_present: false, emitter_stale: false, notes: [], ...over,
});

let state: any;
let calls: Array<{ url: string; method: string; body?: any }>;

function mockFetch(handler?: (url: string, init?: RequestInit) => any) {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const custom = handler?.(url, init);
    if (custom) return custom;
    return { ok: true, status: 200, json: async () => state };
  }) as any;
}

beforeEach(() => {
  state = { install_mode: "npm", agents: [row({}), row({ id: "aider", name: "Aider", hooks_supported: false })], alerts: [], prompt: null, docker_commands: {} };
});
afterEach(() => cleanup());

describe("AgentsPanel", () => {
  it("lists agents; hook-less agents say 'MCP capture only' and offer no hook install", async () => {
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("MCP capture only")).toBeTruthy();
    expect(screen.queryByLabelText("Install hooks for Aider")).toBeNull();
  });

  it("enabling an agent PATCHes it, shows the install result, then shows the refreshed state", async () => {
    mockFetch((url, init) => {
      if (init?.method === "PATCH") {
        state = { ...state, agents: [row({ enabled: true, hooks_installed: true }), state.agents[1]] };
        return { ok: true, status: 200, json: async () => ({ agent: "claude-code", enabled: true, install: { ok: true, changed: true, notes: [] }, docker_command: null, note: null }) };
      }
    });
    render(<AgentsPanel />);
    fireEvent.click(await screen.findByLabelText("Enable Claude Code"));
    expect(await screen.findByText("Hooks installed.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/agents/claude-code", body: { enabled: true } });
    await waitFor(() => expect(screen.getByText(/waiting for the first event/)).toBeTruthy());
  });

  it("surfaces an install failure instead of hiding it", async () => {
    mockFetch((url, init) => {
      if (init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({ agent: "claude-code", enabled: true, install: { ok: false, changed: false, error: "settings.json is not valid JSON", notes: [] }, docker_command: null, note: null }) };
    });
    render(<AgentsPanel />);
    fireEvent.click(await screen.findByLabelText("Enable Claude Code"));
    expect(await screen.findByText(/Install failed: settings\.json is not valid JSON/)).toBeTruthy();
  });

  it("docker mode shows a copyable command instead of install buttons", async () => {
    state = { ...state, install_mode: "docker", agents: [row({ enabled: true }), state.agents[1]], docker_commands: { "claude-code": "docker run --rm safiyu/kontexta hooks install --agent claude-code" } };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText(/hooks install --agent claude-code/)).toBeTruthy();
    expect(screen.queryByLabelText("Install hooks for Claude Code")).toBeNull();
    fireEvent.click(screen.getByLabelText("Copy install command for Claude Code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("docker run --rm safiyu/kontexta hooks install --agent claude-code"));
  });

  it("shows verified status with the last event time", async () => {
    state = { ...state, agents: [row({ enabled: true, hooks_installed: true, hooks_verified_at: "2026-09-29T09:00:00.000Z", last_hook_event_at: "2026-09-29T10:00:00.000Z" }), state.agents[1]] };
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText(/verified · last event/)).toBeTruthy();
  });

  it("shows an error when the agents API is unavailable", async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<AgentsPanel />);
    expect(await screen.findByText(/Could not load agents/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/agents/agents-panel.test.tsx`
Expected: FAIL — `./agents-panel` not found.

- [ ] **Step 3: Implement the hook**

`apps/web/src/hooks/use-agents.ts`:
```ts
"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export const AGENTS_CHANGED_EVENT = "kontexta:agents-changed";

export interface AgentInfo {
  id: string; name: string; enabled: boolean; hooks_supported: boolean; onboardable: boolean;
  hooks_installed: boolean; hooks_version: string | null; hooks_verified_at: string | null; last_hook_event_at: string | null;
  config_present: boolean; emitter_stale: boolean; notes: string[];
}
export interface AgentsState {
  install_mode: "docker" | "npm" | "source";
  agents: AgentInfo[];
  alerts: Array<{ agent: string; name: string; installed: boolean; verified_at: string | null }>;
  prompt: string | null;
  docker_commands: Record<string, string>;
}
export interface InstallOutcome { ok: boolean; changed: boolean; error?: string; notes: string[] }
export interface ToggleResult { agent: string; enabled: boolean; install: InstallOutcome | null; docker_command: string | null; note: string | null }

const notifyChanged = () => window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));

export function useAgents() {
  const [state, setState] = useState<AgentsState | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        if (mine === seq.current) setState(Array.isArray(data?.agents) ? (data as AgentsState) : null);
      } else if (mine === seq.current) setState(null);
    } catch {
      if (mine === seq.current) setState(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const setEnabled = useCallback(async (id: string, enabled: boolean): Promise<ToggleResult | null> => {
    try {
      const res = await fetch(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      if (!res.ok) return null;
      const result = (await res.json()) as ToggleResult;
      notifyChanged();
      return result;
    } catch { return null; }
  }, []);

  const hooksAction = useCallback(async (id: string, action: "install" | "uninstall") => {
    try {
      const res = await fetch(`/api/agents/${id}/hooks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const json = await res.json().catch(() => ({}));
      notifyChanged();
      return { ok: res.ok, status: res.status, ...json } as { ok: boolean; status: number; outcome?: InstallOutcome; docker_command?: string; error?: string };
    } catch { return { ok: false, status: 0, error: "Request failed" }; }
  }, []);

  return { state, loading, refresh, setEnabled, hooksAction };
}
```

- [ ] **Step 4: Implement the panel**

`apps/web/src/components/agents/agents-panel.tsx`:
```tsx
"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useAgents, type AgentInfo, type InstallOutcome } from "@/hooks/use-agents";

function statusText(a: AgentInfo, mode: string): string {
  if (!a.hooks_supported) return "MCP capture only";
  if (!a.enabled) return "—";
  if (a.hooks_verified_at) return `verified · last event ${new Date(a.last_hook_event_at ?? a.hooks_verified_at).toLocaleString()}`;
  if (mode === "docker") return "run the command below on your machine";
  if (a.hooks_installed) return `installed${a.emitter_stale ? " (emitter outdated)" : ""} — waiting for the first event`;
  return "not installed";
}

function outcomeMessage(o: InstallOutcome | null | undefined, verb: "install" | "uninstall"): string {
  if (!o) return "";
  if (!o.ok) return `${verb === "install" ? "Install" : "Uninstall"} failed: ${o.error}`;
  const base = verb === "install" ? (o.changed ? "Hooks installed." : "Hooks already up to date.") : (o.changed ? "Hooks removed." : "Nothing to remove.");
  return o.notes.length > 0 ? `${base} ${o.notes.join(" ")}` : base;
}

export function AgentsPanel() {
  const { state, loading, setEnabled, hooksAction } = useAgents();
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  if (loading && !state) return <p className="text-sm text-[var(--text-secondary)]">Loading agents…</p>;
  if (!state) return <p role="alert" className="text-sm text-[var(--danger)]">Could not load agents.</p>;

  const say = (id: string, msg: string) => setMessages((m) => ({ ...m, [id]: msg }));

  async function onToggle(a: AgentInfo, enabled: boolean) {
    const r = await setEnabled(a.id, enabled);
    if (!r) return say(a.id, "Request failed.");
    if (r.install) return say(a.id, outcomeMessage(r.install, "install"));
    if (r.docker_command) return say(a.id, "Run the command below on your machine to install hooks.");
    say(a.id, r.note ?? "");
  }

  async function onAction(a: AgentInfo, action: "install" | "uninstall") {
    const r = await hooksAction(a.id, action);
    say(a.id, r.outcome ? outcomeMessage(r.outcome, action) : (r.error ?? "Request failed."));
  }

  async function onCopy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500); } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <p className="text-sm text-[var(--text-secondary)]">
        Enable the coding agents you use. Kontexta installs hooks so the journal also captures your prompts, the agent&apos;s replies and the shell commands it runs.
        Agents that are off are ignored everywhere. Per-agent limits: docs/HOOKS.md.
      </p>
      <ul className="divide-y divide-[var(--border)] border border-[var(--border)] rounded">
        {state.agents.map((a) => (
          <li key={a.id} className="p-3 space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                role="switch"
                aria-label={`Enable ${a.name}`}
                checked={a.enabled}
                onChange={(e) => void onToggle(a, e.target.checked)}
              />
              <span className="font-medium text-[var(--text-primary)] w-48">{a.name}</span>
              <span className="flex-1 text-xs text-[var(--text-secondary)]">{statusText(a, state.install_mode)}</span>
              {a.enabled && a.hooks_supported && state.install_mode !== "docker" && (
                <span className="flex gap-2">
                  <button className="btn btn-sm" aria-label={`Install hooks for ${a.name}`} onClick={() => void onAction(a, "install")}>
                    {a.hooks_installed ? "Reinstall" : "Install"}
                  </button>
                  {a.hooks_installed && (
                    <button className="btn btn-sm btn-destructive" aria-label={`Uninstall hooks for ${a.name}`} onClick={() => void onAction(a, "uninstall")}>
                      Uninstall
                    </button>
                  )}
                </span>
              )}
            </div>
            {a.enabled && a.hooks_supported && state.install_mode === "docker" && state.docker_commands[a.id] && (
              <div className="flex items-start gap-2">
                <pre className="flex-1 overflow-x-auto text-xs bg-[var(--bg-secondary)] p-2 rounded">{state.docker_commands[a.id]}</pre>
                <button className="btn btn-icon-sm btn-outline" aria-label={`Copy install command for ${a.name}`} onClick={() => void onCopy(a.id, state.docker_commands[a.id])}>
                  {copied === a.id ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
                </button>
              </div>
            )}
            {messages[a.id] && <p className="text-xs text-[var(--text-secondary)]" role="status">{messages[a.id]}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Add the tab to the Configure modal**

In `apps/web/src/components/docs/docs-modal.tsx`: add `import { AgentsPanel } from "@/components/agents/agents-panel";` and `import { useEffect, useState } from "react";`; change `type Tab = "tools" | "install" | "builder" | "journal";` to `export type Tab = "tools" | "install" | "agents" | "builder" | "journal";`; insert `{ id: "agents", label: "AGENTS" },` after the `install` entry of `TABS`; add `initialTab?: Tab;` to `DocsModalProps`; take `initialTab` in the component signature and add
```tsx
  useEffect(() => { if (open && initialTab) setTab(initialTab); }, [open, initialTab]);
```
after the `useState`; and render `{tab === "agents" && <AgentsPanel />}` next to the other tab bodies.

- [ ] **Step 6: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/agents/agents-panel.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; typecheck clean.

---

### Task 6: Alert banner, mounted in the home layout

**Files:**
- Create: `apps/web/src/components/agents/hooks-banner.tsx`
- Modify: `apps/web/src/app/home-client.tsx` (mount the banner; give the Configure modal an initial tab)
- Test: `apps/web/src/components/agents/hooks-banner.test.tsx`

**Interfaces:**
- Consumes: `useAgents()`, `Tab` and `DocsModal`'s `initialTab` prop (Task 5).
- Produces: `HooksBanner({ onOpen }: { onOpen: () => void })` — renders nothing unless `state.alerts` is non-empty and the current alert set has not been dismissed this session (dismissal is keyed to the exact set of alerting agent ids, so enabling another agent later brings the banner back).

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/agents/hooks-banner.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HooksBanner } from "./hooks-banner";

const stateWith = (alerts: Array<{ agent: string; name: string; installed: boolean }>) => ({
  install_mode: "npm", agents: [], alerts: alerts.map((a) => ({ ...a, verified_at: null })), prompt: null, docker_commands: {},
});
const serve = (state: unknown) => { global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => state })) as any; };

beforeEach(() => sessionStorage.clear());
afterEach(() => cleanup());

describe("HooksBanner", () => {
  it("renders nothing when there are no alerts", async () => {
    serve(stateWith([]));
    const { container } = render(<HooksBanner onOpen={() => {}} />);
    await waitFor(() => expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });

  it("names the agents that need hooks and opens the Agents tab on click", async () => {
    serve(stateWith([{ agent: "claude-code", name: "Claude Code", installed: false }, { agent: "gemini", name: "Gemini CLI", installed: false }]));
    const onOpen = vi.fn();
    render(<HooksBanner onOpen={onOpen} />);
    expect(await screen.findByText(/Hooks not installed for Claude Code, Gemini CLI/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up hooks" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("distinguishes installed-but-silent agents", async () => {
    serve(stateWith([{ agent: "cursor", name: "Cursor", installed: true }]));
    render(<HooksBanner onOpen={() => {}} />);
    expect(await screen.findByText(/No events yet from Cursor/)).toBeTruthy();
  });

  it("dismissal sticks for the same alert set but not for a new one", async () => {
    serve(stateWith([{ agent: "gemini", name: "Gemini CLI", installed: false }]));
    const first = render(<HooksBanner onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(first.container.textContent).toBe(""));
    first.unmount();

    serve(stateWith([{ agent: "gemini", name: "Gemini CLI", installed: false }]));
    const same = render(<HooksBanner onOpen={() => {}} />);
    await waitFor(() => expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(same.container.textContent).toBe("");
    same.unmount();

    serve(stateWith([{ agent: "gemini", name: "Gemini CLI", installed: false }, { agent: "codex", name: "Codex CLI", installed: false }]));
    render(<HooksBanner onOpen={() => {}} />);
    expect(await screen.findByText(/Gemini CLI, Codex CLI/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/agents/hooks-banner.test.tsx`
Expected: FAIL — `./hooks-banner` not found.

- [ ] **Step 3: Implement the banner**

`apps/web/src/components/agents/hooks-banner.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useAgents } from "@/hooks/use-agents";

const DISMISS_KEY = "hooksBannerDismissed";

export function HooksBanner({ onOpen }: { onOpen: () => void }) {
  const { state } = useAgents();
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);

  useEffect(() => { setDismissedSig(sessionStorage.getItem(DISMISS_KEY)); }, []);

  const alerts = state?.alerts ?? [];
  const signature = alerts.map((a) => a.agent).sort().join(",");
  if (alerts.length === 0 || dismissedSig === signature) return null;

  const missing = alerts.filter((a) => !a.installed).map((a) => a.name);
  const silent = alerts.filter((a) => a.installed).map((a) => a.name);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Hooks not installed for ${missing.join(", ")}`);
  if (silent.length > 0) parts.push(`No events yet from ${silent.join(", ")}`);

  return (
    <div role="alert" aria-label={parts.join(". ")} className="mx-4 mt-2 flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-2 text-[var(--text-primary)]">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
      <p className="flex-1 text-sm">{parts.join(". ")}.</p>
      <button className="btn btn-sm btn-outline" onClick={onOpen}>Set up hooks</button>
      <button
        className="btn btn-icon-sm"
        aria-label="Dismiss"
        onClick={() => { sessionStorage.setItem(DISMISS_KEY, signature); setDismissedSig(signature); }}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Mount it in `home-client.tsx`**

Add imports: `import { HooksBanner } from "@/components/agents/hooks-banner";` and change `import { DocsModal } from "@/components/docs/docs-modal";` to `import { DocsModal, type Tab as DocsTab } from "@/components/docs/docs-modal";`. Next to the existing `docsOpen` state add `const [docsTab, setDocsTab] = useState<DocsTab | undefined>(undefined);`. Insert directly after `<Breadcrumb segments={breadcrumbSegments} />`:
```tsx
      <HooksBanner onOpen={() => { setDocsTab("agents"); setDocsOpen(true); }} />
```
Change the `DocsModal` usage to:
```tsx
      <DocsModal
        open={docsOpen}
        onClose={() => { setDocsOpen(false); setDocsTab(undefined); }}
        initialTab={docsTab}
      />
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/agents/ && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; typecheck clean.

---

### Task 7: First-run wizard rework (agents → hooks → profile → onboard) and mount on first setup

`FirstRunWizard` exists but is not mounted anywhere; today `/?setup=1` just opens the Configure modal. Rework the wizard and mount it there.

**Files:**
- Modify (rewrite): `apps/web/src/components/file-list/first-run-wizard.tsx`
- Modify: `apps/web/src/app/home-client.tsx` (open the wizard on `?setup=1`, render it)
- Test: `apps/web/src/components/file-list/first-run-wizard.test.tsx`

**Interfaces:**
- Consumes: `useAgents()` (Task 5).
- Produces: `FirstRunWizard({ open, onClose, initialStep?, projects, onSaved })` — props unchanged. Steps: 1 agents (multi-select; Continue applies the selection through `setEnabled`, which installs hooks immediately outside Docker), 2 hooks results (per-agent status / error + Retry / Docker command with Copy / "MCP capture only"), 3 profile (unchanged behavior; `Skip` still closes the wizard), 4 onboard (choices limited to enabled agents that have a rules scaffold, falling back to all scaffold-capable agents).

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/file-list/first-run-wizard.test.tsx`:
```tsx
// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FirstRunWizard } from "./first-run-wizard";

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, enabled: false, hooks_supported: true, onboardable: true, hooks_installed: false, hooks_version: null,
  hooks_verified_at: null, last_hook_event_at: null, config_present: false, emitter_stale: false, notes: [], ...over,
});

let state: any;
let patches: Array<{ id: string; enabled: boolean }>;
let failing: Set<string>;

beforeEach(() => {
  patches = []; failing = new Set();
  state = { install_mode: "npm", agents: [row("claude-code", "Claude Code"), row("gemini", "Gemini CLI"), row("aider", "Aider", { hooks_supported: false })], alerts: [], prompt: null, docker_commands: {} };
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /^\/api\/agents\/([^/]+)$/.exec(url);
    if (m && init?.method === "PATCH") {
      const enabled = JSON.parse(String(init.body)).enabled;
      patches.push({ id: m[1], enabled });
      const a = state.agents.find((x: any) => x.id === m[1]);
      a.enabled = enabled;
      const ok = !failing.has(m[1]);
      if (enabled && a.hooks_supported && ok) a.hooks_installed = true;
      const install = enabled && a.hooks_supported ? (ok ? { ok: true, changed: true, notes: [] } : { ok: false, changed: false, error: "settings.json is not valid JSON", notes: [] }) : null;
      return { ok: true, status: 200, json: async () => ({ agent: m[1], enabled, install, docker_command: null, note: null }) };
    }
    if (url === "/api/agents") return { ok: true, status: 200, json: async () => state };
    if (url === "/api/profile") return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as any;
});
afterEach(() => cleanup());

const renderWizard = () => render(<FirstRunWizard open onClose={() => {}} projects={[]} onSaved={() => {}} />);

describe("FirstRunWizard", () => {
  it("step 1 lists agents; hook-less ones are marked MCP capture only", async () => {
    renderWizard();
    expect(await screen.findByText("Which coding agents do you use?")).toBeTruthy();
    expect(screen.getByLabelText("Claude Code")).toBeTruthy();
    expect(screen.getByText("MCP capture only")).toBeTruthy();
  });

  it("enabling agents applies them (installing hooks) and step 2 reports each result, with a retry for failures", async () => {
    failing.add("gemini");
    renderWizard();
    fireEvent.click(await screen.findByLabelText("Claude Code"));
    fireEvent.click(screen.getByLabelText("Gemini CLI"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Install hooks")).toBeTruthy();
    expect(patches).toEqual([{ id: "claude-code", enabled: true }, { id: "gemini", enabled: true }]);
    expect(await screen.findByText(/Install failed: settings\.json is not valid JSON/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Gemini CLI" })).toBeTruthy();
    expect(screen.getByText(/Claude Code.*installed/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Set Up Your Profile")).toBeTruthy();
  });

  it("'Skip for now' jumps to the profile step without enabling anything", async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("Set Up Your Profile")).toBeTruthy();
    expect(patches).toEqual([]);
  });

  it("docker mode shows the host command with a copy button instead of installing", async () => {
    state.install_mode = "docker";
    state.docker_commands = { "claude-code": "docker run --rm safiyu/kontexta hooks install --agent claude-code" };
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/agents/claude-code" && init?.method === "PATCH") {
        state.agents[0].enabled = true;
        return { ok: true, status: 200, json: async () => ({ agent: "claude-code", enabled: true, install: null, docker_command: state.docker_commands["claude-code"], note: null }) };
      }
      return { ok: true, status: 200, json: async () => state };
    }) as any;
    renderWizard();
    fireEvent.click(await screen.findByLabelText("Claude Code"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/hooks install --agent claude-code/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy install command for Claude Code" })).toBeTruthy();
  });

  it("the onboard step offers only enabled agents that have a rules scaffold", async () => {
    renderWizard();
    fireEvent.click(await screen.findByLabelText("Claude Code"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Install hooks");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Set Up Your Profile");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Onboard an Agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gemini CLI/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/file-list/first-run-wizard.test.tsx`
Expected: FAIL — the current wizard starts on the profile step and has no agents step.

- [ ] **Step 3: Rewrite the wizard**

Replace `apps/web/src/components/file-list/first-run-wizard.tsx` with:
```tsx
"use client";

import { useState, useEffect } from "react";
import { X, AlertCircle, Copy, Check } from "lucide-react";
import { useAgents, type ToggleResult } from "@/hooks/use-agents";

interface FirstRunWizardProps {
  open: boolean;
  onClose: () => void;
  initialStep?: number;
  projects: any[];
  onSaved: () => void;
}

interface ProfileSections { name: string; role: string; vision: string; roadmap: string; preferences: string; notes: string }

const TITLES: Record<number, string> = {
  1: "Which coding agents do you use?",
  2: "Install hooks",
  3: "Set Up Your Profile",
  4: "Onboard an Agent",
};
const PRIMARY = "rounded-md bg-blue-200 px-4 py-2 text-sm text-blue-900 hover:bg-blue-300 disabled:opacity-50";
const SECONDARY = "rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--bg-tertiary)]";

export function FirstRunWizard({ open, onClose, initialStep = 1, projects, onSaved }: FirstRunWizardProps) {
  const { state, setEnabled, hooksAction } = useAgents();
  const [step, setStep] = useState(initialStep);
  const [sections, setSections] = useState<ProfileSections>({ name: "", role: "", vision: "", roadmap: "", preferences: "", notes: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [results, setResults] = useState<Record<string, ToggleResult>>({});
  const [retryErrors, setRetryErrors] = useState<Record<string, string | null>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setError(null);
    if (projects.length > 0 && !selectedProject) setSelectedProject(projects[0].id);
  }, [open, initialStep, projects, selectedProject]);

  useEffect(() => {
    if (state && !seeded) { setSelected(new Set(state.agents.filter((a) => a.enabled).map((a) => a.id))); setSeeded(true); }
  }, [state, seeded]);

  if (!open) return null;

  const agents = state?.agents ?? [];
  const onboardChoices = (() => {
    const enabled = agents.filter((a) => a.enabled && a.onboardable);
    return enabled.length > 0 ? enabled : agents.filter((a) => a.onboardable);
  })();

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const applyAgents = async () => {
    setSaving(true); setError(null);
    const next: Record<string, ToggleResult> = {};
    for (const a of agents) {
      const want = selected.has(a.id);
      if (want === a.enabled) continue;
      const r = await setEnabled(a.id, want);
      if (!r) { setError(`Could not ${want ? "enable" : "disable"} ${a.name}`); setSaving(false); return; }
      if (want) next[a.id] = r;
    }
    setResults(next);
    setSaving(false);
    setStep(2);
  };

  const retry = async (id: string) => {
    const r = await hooksAction(id, "install");
    setRetryErrors((e) => ({ ...e, [id]: r.outcome?.ok ? null : (r.outcome?.error ?? r.error ?? "Install failed") }));
  };

  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); } catch { /* clipboard unavailable */ }
  };

  const handleSaveProfile = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sections }) });
      if (!res.ok) throw new Error("Failed to save profile");
      setStep(4);
    } catch (e: any) {
      setError(e?.message || "Failed to save profile");
    } finally { setSaving(false); }
  };

  const handleOnboardAgent = async () => {
    if (!selectedAgent) { setError("Please select an agent"); return; }
    setSaving(true); setError(null);
    try {
      const projectId = projects.length > 0 ? selectedProject : null;
      const res = await fetch("/api/projects/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: selectedAgent, project_id: projectId }) });
      if (!res.ok) throw new Error("Failed to onboard agent");
      onSaved(); onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to onboard agent");
    } finally { setSaving(false); }
  };

  const hooksRow = (id: string) => {
    const a = agents.find((x) => x.id === id);
    if (!a) return null;
    const r = results[id];
    const retryErr = retryErrors[id];
    const failure = retryErr !== undefined ? retryErr : (r?.install && !r.install.ok ? `Install failed: ${r.install.error}` : null);
    const dockerCmd = r?.docker_command ?? state?.docker_commands[id] ?? null;
    let body: React.ReactNode;
    if (!a.hooks_supported) body = <span className="text-[var(--text-secondary)]">MCP capture only — this agent has no hook API.</span>;
    else if (state?.install_mode === "docker" && dockerCmd) body = (
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto text-xs bg-[var(--bg-secondary)] p-2 rounded">{dockerCmd}</pre>
        <button className="btn btn-icon-sm btn-outline" aria-label={`Copy install command for ${a.name}`} onClick={() => void copy(id, dockerCmd)}>
          {copied === id ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
        </button>
      </div>
    );
    else if (failure) body = (
      <span className="flex items-center gap-2 text-[var(--danger)]">
        {failure}
        <button className={SECONDARY} aria-label={`Retry ${a.name}`} onClick={() => void retry(id)}>Retry</button>
      </span>
    );
    else if (a.hooks_installed) body = <span>{a.name} installed ✓</span>;
    else body = <span className="text-[var(--text-secondary)]">Not installed yet.</span>;
    return <li key={id} className="rounded-md border border-[var(--border)] p-3 text-sm"><div className="font-medium mb-1">{a.name}</div>{body}</li>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-6 shadow-xl">
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-md p-1 text-[var(--muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]">
          <X className="h-5 w-5" />
        </button>

        <h2 className="mb-4 text-xl font-semibold">{TITLES[step]}</h2>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger)]" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Pick the agents you use. Kontexta installs hooks for them so your conversations and shell commands reach the journal — agents you leave off are ignored everywhere.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {agents.map((a) => (
                <label key={a.id} className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm hover:bg-[var(--bg-tertiary)] cursor-pointer">
                  <input type="checkbox" aria-label={a.name} checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <span>
                    <span className="font-medium">{a.name}</span>
                    {!a.hooks_supported && <span className="block text-xs text-[var(--text-secondary)]">MCP capture only</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={() => setStep(3)}>Skip for now</button>
              <button className={PRIMARY} onClick={() => void applyAgents()} disabled={saving || !state}>{saving ? "Applying…" : "Continue"}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <ul className="space-y-2">
              {[...selected].map((id) => hooksRow(id))}
              {selected.size === 0 && <li className="text-sm text-[var(--text-secondary)]">No agents enabled — you can enable them later from Configure → AGENTS.</li>}
            </ul>
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={() => setStep(1)}>Back</button>
              <button className={PRIMARY} onClick={() => setStep(3)}>Continue</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">Help AI agents understand you better by filling in your profile.</p>
            {(["name", "role", "vision", "roadmap", "preferences", "notes"] as const).map((field) => (
              <div key={field}>
                <label className="mb-1 block text-sm font-medium capitalize text-[var(--text-secondary)]">{field}</label>
                {field === "notes" ? (
                  <textarea value={sections[field]} onChange={(e) => setSections({ ...sections, [field]: e.target.value })} className="w-full rounded-md border px-3 py-2 text-sm" rows={3} placeholder={`Enter your ${field}...`} />
                ) : (
                  <input type="text" value={sections[field]} onChange={(e) => setSections({ ...sections, [field]: e.target.value })} className="w-full rounded-md border px-3 py-2 text-sm" placeholder={`Enter your ${field}...`} />
                )}
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={onClose}>Skip</button>
              <button className={PRIMARY} onClick={() => void handleSaveProfile()} disabled={saving}>{saving ? "Saving..." : "Continue"}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">Select an AI coding agent to onboard with your kontexta setup.</p>
            {projects.length > 1 && (
              <div>
                <label className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Target project</label>
                <select value={selectedProject ?? ""} onChange={(e) => setSelectedProject(Number(e.target.value))} className="w-full rounded-md border px-3 py-2 text-sm">
                  {projects_map((p) => <option key={p.id} value={p.id}>{p.name || `Project ${p.id}`}</option>)}
                  <option value="">Knowledge Base (no project)</option>
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {onboardChoices.map((a) => (
                <button key={a.id} onClick={() => setSelectedAgent(a.id)} className={`rounded-lg border p-3 text-left text-sm transition-colors ${selectedAgent === a.id ? "border-blue-300 bg-blue-100 text-blue-800" : "hover:bg-[var(--bg-tertiary)]"}`}>
                  <div className="font-medium">{a.name}</div>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={() => setStep(3)}>Back</button>
              <button className={PRIMARY} onClick={() => void handleOnboardAgent()} disabled={saving || !selectedAgent}>{saving ? "Onboarding..." : "Onboard Agent"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount the wizard in `home-client.tsx`**

Add `import { FirstRunWizard } from "@/components/file-list/first-run-wizard";` and state `const [wizardOpen, setWizardOpen] = useState(false);` next to `docsOpen`. In the `?setup=1` effect replace `setDocsOpen(true);` with `setWizardOpen(true);` (update the comment above it to say it opens the first-run wizard). After the `DocsModal` element add:
```tsx
      <FirstRunWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        projects={projects}
        onSaved={refreshProjects}
      />
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/file-list/first-run-wizard.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; typecheck clean.

---

### Task 8: Configure section shows only enabled agents

**Files:**
- Modify: `apps/web/src/app/docs/install/install-section.tsx`
- Modify (extend): `apps/web/src/app/docs/install/install-section.test.tsx`

**Interfaces:**
- Consumes: `useAgents()` (Task 5). `CLIENTS` ids in this file already equal agent ids (`claude-code`, `claude-desktop`, `cursor`, `codex`, `gemini`, `antigravity`, `continue`, `aider`, `cline`, `copilot`, `hermes`, `generic`). `generic` is always shown. Agents with no MCP template here (`windsurf`, `kiro`, `opencode`) are simply not listed — adding templates for them is out of scope.
- Behavior: agents state unavailable → all clients (fail-open). Available → enabled agents plus `generic`; when none are enabled, only `generic` plus a hint. If the currently selected client becomes hidden, select the first visible one.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/app/docs/install/install-section.test.tsx`:
```tsx
describe("InstallSection — enabled-agent filter", () => {
  const agentRow = (id: string, enabled: boolean) => ({ id, name: id, enabled, hooks_supported: true, onboardable: true, hooks_installed: false, hooks_version: null, hooks_verified_at: null, last_hook_event_at: null, config_present: false, emitter_stale: false, notes: [] });
  const serve = (agents: Response | { ok: boolean; json: () => Promise<unknown> }) => {
    global.fetch = vi.fn(async (url: string) => {
      if (url === "/api/agents") return agents;
      return { ok: true, json: async () => ({ kind: "shell", body: "docker run safiyu/kontexta", notes: [], detectedInstall: "docker" }) };
    }) as any;
  };
  const clientLabels = () => Array.from((screen.getByLabelText("AI client") as HTMLSelectElement).options).map((o) => o.textContent);

  it("lists only enabled agents plus Generic JSON", async () => {
    serve({ ok: true, json: async () => ({ install_mode: "npm", agents: [agentRow("claude-code", true), agentRow("cursor", true), agentRow("gemini", false)], alerts: [], prompt: null, docker_commands: {} }) });
    render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toEqual(["Claude Code", "Cursor", "Generic JSON"]));
  });

  it("with nothing enabled shows Generic JSON and a hint to use the AGENTS tab", async () => {
    serve({ ok: true, json: async () => ({ install_mode: "npm", agents: [agentRow("claude-code", false)], alerts: [], prompt: null, docker_commands: {} }) });
    render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toEqual(["Generic JSON"]));
    expect(screen.getByText(/enable the agents you use in the AGENTS tab/i)).toBeTruthy();
  });

  it("re-selects a visible client when the default one is hidden", async () => {
    serve({ ok: true, json: async () => ({ install_mode: "npm", agents: [agentRow("cursor", true)], alerts: [], prompt: null, docker_commands: {} }) });
    render(<InstallSection />);
    await waitFor(() => expect((screen.getByLabelText("AI client") as HTMLSelectElement).value).toBe("cursor"));
  });

  it("fails open when the agents API errors or returns an unexpected shape", async () => {
    serve({ ok: false, json: async () => ({}) });
    const first = render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toHaveLength(12));
    first.unmount();
    serve({ ok: true, json: async () => ({ unexpected: true }) });
    render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toHaveLength(12));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/app/docs/install/install-section.test.tsx`
Expected: the four new tests FAIL (all 12 clients always listed); the two existing tests still pass.

- [ ] **Step 3: Implement the filter**

In `install-section.tsx`: change the react import to `import { useEffect, useMemo, useState } from "react";`, add `import { useAgents } from "@/hooks/use-agents";`, and inside `InstallSection` (before the snippet-fetch effect) add:
```tsx
  const { state: agentsState } = useAgents();
  const enabledIds = useMemo(() => new Set((agentsState?.agents ?? []).filter((a) => a.enabled).map((a) => a.id)), [agentsState]);
  // Fail open: with no agents state we cannot tell what is enabled, so show everything.
  const visibleClients = useMemo(
    () => (agentsState ? CLIENTS.filter((c) => c.id === "generic" || enabledIds.has(c.id)) : CLIENTS),
    [agentsState, enabledIds],
  );
  const nothingEnabled = !!agentsState && enabledIds.size === 0;

  useEffect(() => {
    if (!visibleClients.some((c) => c.id === client)) setClient(visibleClients[0].id);
  }, [visibleClients, client]);
```
Replace `{CLIENTS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}` with `{visibleClients.map(...)}`, and right after the `<div className="flex gap-3 mb-4">…</div>` selector row add:
```tsx
      {nothingEnabled && (
        <p className="mb-3 text-xs text-[var(--text-secondary)]">No agents enabled yet — enable the agents you use in the AGENTS tab to see their config here.</p>
      )}
      {agentsState && !nothingEnabled && (
        <p className="mb-3 text-xs text-[var(--text-secondary)]">Missing an agent? Enable it in the AGENTS tab.</p>
      )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/app/docs/install/ && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS (existing tests unchanged: their mock returns a non-agents JSON for `/api/agents`, which `useAgents` rejects → fail-open).

---

### Task 9: MCP surfaces — `hooks` block, `admin_onboard_agent({hooks:true})`, session-context nudge

**Files:**
- Create: `apps/mcp/src/hooks-block.ts`
- Modify: `apps/mcp/src/index.ts` (imports; `projects_register` response; `admin_onboard_agent` schema/handler/description; `loadProfileInstructions`)
- Test: `apps/mcp/tests/hooks-onboarding.test.mjs`

**Interfaces:**
- Consumes from `kxta-core`: `buildHooksBlock`, `detectInstallMode`, `installHooks`, `setEnabled`, `syncAgentRows`, `isAgentId`, `agentMeta`, `dockerInstallCommand`, `getDataDir`, types `HooksBlock`, `AgentHookOutcome`.
- Produces:
```ts
function currentHooksBlock(version: string): HooksBlock | null      // null when there are no alerts (or on any error)
interface HooksInstallResult { agent; mode; enabled: boolean; outcome?: AgentHookOutcome; docker_command?: string; note?: string; error?: string }
function enableAndInstallHooks(agent: string, version: string): HooksInstallResult
```
- Tool contract: `admin_onboard_agent` gains optional `hooks: boolean`. With `hooks:true` and `confirm:true`: `target_agent` is required (validated **before** any file is written); the response gains `hooks_install`. `projects_register`, `admin_onboard_agent` and the session context gain `hooks` / a `🪝` line **only when `currentHooksBlock` is non-null**.

- [ ] **Step 1: Write the failing test**

`apps/mcp/tests/hooks-onboarding.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DIST = resolve(import.meta.dirname, "../dist");
const SERVER = join(DIST, "index.js");
const CLI = join(DIST, "hooks-cli.js");

function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, KONTEXTA_DISTILL_ENGINE: "off", ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; let nextId = 1; const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 15000);
  });
  return {
    async init() {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hooks-test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args = {}) => rpc("tools/call", { name, arguments: args }),
    stop: () => child.kill("SIGTERM"),
  };
}

const json = (r) => JSON.parse(r.content[0].text);

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kx-oh-home-"));
  const data = mkdtempSync(join(tmpdir(), "kx-oh-data-"));
  const proj = mkdtempSync(join(tmpdir(), "kx-oh-proj-"));
  writeFileSync(join(proj, "README.md"), "# demo\n");
  const cleanup = () => { for (const d of [home, data, proj]) rmSync(d, { recursive: true, force: true }); };
  return { home, data, proj, env: { HOME: home, KONTEXTA_DATA_DIR: data, KONTEXTA_INSTALL_HINT: "npm" }, cleanup };
}

test("no enabled agents → no hooks block anywhere", async () => {
  const f = fixture(); const s = startServer(f.env);
  try {
    await s.init();
    const reg = await s.call("projects_register", { name: "demo", path: f.proj });
    assert.equal(reg.isError, undefined);
    assert.equal("hooks" in json(reg), false);
    const ctx = await s.call("admin_refresh_session_context");
    assert.ok(!ctx.content[0].text.includes("🪝"));
  } finally { s.stop(); f.cleanup(); }
});

test("enabled agent → register carries alerts + PROMPT; onboard hooks:true installs; nudge disappears", async () => {
  const f = fixture();
  assert.equal(cli(["enable", "claude-code", "--no-install"], f.env).status, 0);
  const s = startServer(f.env);
  try {
    await s.init();
    const reg = await s.call("projects_register", { name: "demo", path: f.proj });
    const body = json(reg);
    assert.equal(body.hooks.install_mode, "npm");
    assert.deepEqual(body.hooks.alerts.map((a) => a.agent), ["claude-code"]);
    assert.ok(reg.content.some((c) => c.text.includes("PROMPT:") && c.text.includes("Claude Code")));
    const before = await s.call("admin_refresh_session_context");
    assert.ok(before.content[0].text.includes("🪝") && before.content[0].text.includes("Claude Code"));

    const done = await s.call("admin_onboard_agent", { project_id: body.project.id, confirm: true, target_agent: "claude-code", hooks: true });
    assert.equal(done.isError, undefined, done.content[0].text);
    const out = json(done);
    assert.equal(out.hooks_install.outcome.ok, true);
    assert.equal("hooks" in out, false);
    assert.ok(existsSync(join(f.home, ".claude", "settings.json")));
    assert.ok(existsSync(join(f.proj, "CLAUDE.md")));

    const after = await s.call("admin_refresh_session_context");
    assert.ok(!after.content[0].text.includes("🪝"));
  } finally { s.stop(); f.cleanup(); }
});

test("docker mode → onboard hooks:true returns the host command and writes nothing", async () => {
  const f = fixture(); f.env.KONTEXTA_INSTALL_HINT = "docker";
  cli(["enable", "gemini", "--no-install"], f.env);
  const s = startServer(f.env);
  try {
    await s.init();
    const reg = json(await s.call("projects_register", { name: "demo", path: f.proj }));
    assert.match(reg.hooks.alerts[0].docker_command, /--agent gemini/);
    const done = json(await s.call("admin_onboard_agent", { project_id: reg.project.id, confirm: true, target_agent: "gemini", hooks: true }));
    assert.match(done.hooks_install.docker_command, /--no-db/);
    assert.equal(done.hooks_install.outcome, undefined);
    assert.ok(!existsSync(join(f.home, ".gemini")));
  } finally { s.stop(); f.cleanup(); }
});

test("hooks:true without target_agent errors before writing anything", async () => {
  const f = fixture(); const s = startServer(f.env);
  try {
    await s.init();
    const reg = json(await s.call("projects_register", { name: "demo", path: f.proj }));
    const r = await s.call("admin_onboard_agent", { project_id: reg.project.id, confirm: true, hooks: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /target_agent is required/);
    assert.ok(!existsSync(join(f.proj, "CLAUDE.md")));
  } finally { s.stop(); f.cleanup(); }
});

test("hooks:true for an agent with no hook API returns a note instead of failing", async () => {
  const f = fixture(); const s = startServer(f.env);
  try {
    await s.init();
    const reg = json(await s.call("projects_register", { name: "demo", path: f.proj }));
    const r = await s.call("admin_onboard_agent", { project_id: reg.project.id, confirm: true, target_agent: "aider", hooks: true });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.match(json(r).hooks_install.note, /MCP capture only/);
    assert.ok(existsSync(join(f.proj, ".aider", "kontexta.md")));
  } finally { s.stop(); f.cleanup(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core build && pnpm -C apps/mcp build && cd apps/mcp && node --test tests/hooks-onboarding.test.mjs`
Expected: FAIL — no `hooks` key in `projects_register`, `hooks` param rejected/ignored by `admin_onboard_agent`.

- [ ] **Step 3: Implement the helper**

`apps/mcp/src/hooks-block.ts`:
```ts
import {
  getDataDir, buildHooksBlock, detectInstallMode, installHooks, setEnabled, syncAgentRows, isAgentId, agentMeta, dockerInstallCommand,
  type HooksBlock, type AgentHookOutcome,
} from "kxta-core";

const hostDir = (): string | null => process.env.KONTEXTA_HOST_DATA_DIR ?? null;

export function currentHooksBlock(version: string): HooksBlock | null {
  try {
    const block = buildHooksBlock({ installMode: detectInstallMode(), version, hostDataDir: hostDir() });
    return block.alerts.length > 0 ? block : null;
  } catch {
    return null;
  }
}

export interface HooksInstallResult {
  agent: string; mode: string; enabled: boolean;
  outcome?: AgentHookOutcome; docker_command?: string; note?: string; error?: string;
}

export function enableAndInstallHooks(agent: string, version: string): HooksInstallResult {
  const mode = detectInstallMode();
  if (!isAgentId(agent)) return { agent, mode, enabled: false, error: `unknown agent: ${agent}` };
  const meta = agentMeta(agent)!;
  if (!meta.hooksSupported) return { agent, mode, enabled: false, note: `${meta.name} has no hook API — MCP capture only.` };
  syncAgentRows();
  setEnabled(agent, true);
  if (mode === "docker") return { agent, mode, enabled: true, docker_command: dockerInstallCommand({ agent, version, hostDataDir: hostDir() }) };
  const [outcome] = installHooks([agent], { dataDir: getDataDir() });
  return { agent, mode, enabled: true, outcome };
}
```

- [ ] **Step 4: Wire `index.ts`**

1. Add `import { currentHooksBlock, enableAndInstallHooks, type HooksInstallResult } from "./hooks-block.js";` next to the other local imports.
2. `projects_register`: directly before `const content: any[] = [` add `const hooksBlock = currentHooksBlock(pkgVersion);`; inside the JSON object after `rules_status: ruleStatuses,` add `...(hooksBlock ? { hooks: hooksBlock } : {}),`; after the existing `if (needsOnboarding && recommendation.prompt) { … }` block add:
```ts
      if (hooksBlock?.prompt) content.push({ type: "text", text: `\nPROMPT: ${hooksBlock.prompt}` });
```
3. `admin_onboard_agent`: add `hooks: z.boolean().optional().describe("With target_agent, also enable that agent and install its conversation-capture hooks (npx/source) or return the host docker command. Ask the user first."),` to the schema; change the handler signature to `async ({ project_id, confirm, files, target_agent, hooks })`; directly after the existing `if (targetFiles.length === 0 && !target_agent) { … }` check add:
```ts
      if (hooks === true && !target_agent) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "target_agent is required when hooks is true" }, null, 2) }],
        };
      }
```
   and replace the final success return with:
```ts
      let hooksInstall: HooksInstallResult | undefined;
      if (hooks === true) hooksInstall = enableAndInstallHooks(target_agent!, pkgVersion);
      const hooksBlock = currentHooksBlock(pkgVersion);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...result, ...(hooksInstall ? { hooks_install: hooksInstall } : {}), ...(hooksBlock ? { hooks: hooksBlock } : {}) }, null, 2),
        }],
      };
```
   In the tool description text add under PARAMETERS: `- hooks: boolean, optional. With target_agent set, also enables that agent and installs its conversation-capture hooks (npx/source installs) or returns the host docker command (Docker). Ask the user before setting it.` and extend RETURNS with `, hooks_install?: { agent, mode, enabled, outcome?, docker_command?, note?, error? }, hooks?: { install_mode, alerts, prompt }`.
4. `loadProfileInstructions`: after `const rulesBlock = …;` add
```ts
  const hooksNudge = currentHooksBlock(pkgVersion)?.prompt;
  const hooksLine = hooksNudge ? `\n🪝 ${hooksNudge}` : "";
```
   and append `, hooksLine` to the array in the final `return [header, "", profileBlock, "", calendarBlock, freshness, rulesBlock, hooksLine]`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C apps/mcp build && cd apps/mcp && node --test tests/hooks-onboarding.test.mjs tests/hooks-cli.test.mjs tests/journal-capture.test.mjs`
Expected: all PASS.

---

### Task 10: Rules-block clause, `rulesVersion` bump, docs

**Files:**
- Modify: `packages/core/src/agent-rules/rules-block.md` (one new Core rule)
- Modify: `packages/core/tests/agent-rules.test.ts:19-31` (required-phrase list)
- Modify: root `package.json` (`rulesVersion` 3.0.0 → 3.1.0), then run `node scripts/sync-versions.js`
- Modify: `docs/HOOKS.md`, `docs/MCP.md`

- [ ] **Step 1: Write the failing test**

In `packages/core/tests/agent-rules.test.ts`, add `"Relay `hooks` prompts once per session",` to the phrase list inside `"RULES_BLOCK_BODY mentions every required workflow rule"`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/agent-rules.test.ts`
Expected: FAIL — phrase not present in the rules block.

- [ ] **Step 3: Add the rule and bump the version**

In `rules-block.md`, directly after the `**Address `journal.suggested_action` before the next tool call.**` paragraph add:
```
**Relay `hooks` prompts once per session.** If a tool response carries a `hooks.prompt` (or the session welcome mentions hooks), tell the user once that kontexta can capture their conversation and shell commands for the agents they enabled. Only call `admin_onboard_agent` with `hooks: true` after they agree.
```
Change `"rulesVersion": "3.0.0"` to `"3.1.0"` in the **root** `package.json`, then run `node scripts/sync-versions.js` from the repo root.

- [ ] **Step 4: Verify the bump touched only version metadata**

Run: `git diff --stat -- package.json apps/mcp/package.json apps/web/package.json apps/publish/package.json packages/cli/package.json packages/core/package.json glama.json && git diff -U0 -- '*package.json' glama.json | grep -E '^[+-] ' | sort | uniq -c`
Expected: only `rulesVersion` lines change (glama.json's stale `2.6.0` also becomes `3.1.0`); no `version` line differs. If a `version` line differs, revert that file's `version` by hand — the bump must not change the package version.

- [ ] **Step 5: Docs**

`docs/HOOKS.md`: in **Install paths → Docker** replace the command with
```bash
docker run --rm -v "$HOME":/host -v "<DATA_DIR>":/app/data safiyu/kontexta:<version> hooks install --home /host --host-data-dir "<DATA_DIR>" --no-db --agent <agent>
```
and add: "`--host-data-dir` is the path baked into the agent's config (the host path); the container keeps using `/app/data` for staging. `--no-db` keeps the installer from opening the SQLite file the dashboard container is using; the dashboard learns the hooks work when the first event arrives (the agent shows as **verified**)." Add a section **Managing agents** describing: first-run wizard (agents → hooks → profile → onboard), Configure → AGENTS tab (toggle installs immediately outside Docker; Docker shows the command), the alert banner, and MCP onboarding (`admin_onboard_agent({hooks:true, target_agent, confirm:true})`, and the `hooks` block in `projects_register`).
`docs/MCP.md`: in the `admin_onboard_agent` row (line ~242) append: "Pass `hooks: true` with `target_agent` to also enable that agent and install its conversation-capture hooks (Docker installs get the host command instead)." and in the `projects_register` returns table (line ~282) append `hooks?: { install_mode, alerts, prompt }` (present only when an enabled agent needs attention).

- [ ] **Step 6: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/agent-rules.test.ts && pnpm -C packages/core build`
Expected: PASS; build clean.

---

### Task 11: Final verification

- [ ] **Step 1: Build everything**

Run: `pnpm -C packages/core build && pnpm -C apps/mcp build && pnpm -C apps/mcp build:npm && pnpm -C apps/mcp build && cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: all exit 0 (the second `apps/mcp build` restores the `tsc` output that the tests import after `build:npm` cleans `dist/`).

- [ ] **Step 2: Run every affected suite**

Run each and read the totals: `cd packages/core && npx vitest run` · `cd apps/mcp && node --test tests/*.test.mjs` · `cd packages/cli && npx vitest run tests/hooks.test.ts tests/doctor.test.ts tests/start.test.ts tests/mcp.test.ts` · `cd apps/web && npx vitest run`.
Expected: all green except the known pre-existing `apps/mcp/tests/profile-tool.test.mjs` (imports `vitest`). After the core run restore the fixture the watcher test deletes: `git checkout -- packages/core/tests/test-watch-data/knowledge/diagram.mmd`.

- [ ] **Step 3: Exercise the UI in a browser (tests do not prove this)**

Run the dashboard (`pnpm -C apps/web dev` or the running dev server on :23002) with a **throwaway** `KONTEXTA_DATA_DIR` and `KONTEXTA_HOOKS_HOME=<temp dir>` so nothing touches your real agent configs. Check, and say explicitly if any of it could not be checked:
  1. `/?setup=1` opens the wizard on "Which coding agents do you use?"; tick Claude Code + Gemini CLI → Continue → step 2 shows both installed; the temp home now has `.claude/settings.json` and `.gemini/settings.json`.
  2. Configure → AGENTS lists all 15 agents; toggling one on installs, off keeps the config; Uninstall removes only kontexta's entries.
  3. Enabled-but-not-installed shows the banner; "Set up hooks" opens the AGENTS tab; Dismiss hides it for the session; enabling a different agent brings it back.
  4. Configure → MCP SERVER CONFIG lists only enabled agents plus Generic JSON.
  5. With `KONTEXTA_INSTALL_HINT=docker` the AGENTS tab and wizard show the `docker run …` command with a working Copy button and never write into the temp home.
  6. Light and dark themes both render the new components legibly.

- [ ] **Step 4: Confirm the real data dir and agent configs were not touched**

Run: `ls "$HOME/Library/Application Support/kontexta" | grep -x hooks || echo clean; git status --short | grep -E "test-watch-data" || echo fixture-clean`
Expected: `clean` unless you deliberately enabled agents in your real dashboard; `fixture-clean`.

---

## Prerequisite: Part A review fixes

The whole-branch review of Part A (final report in the Part A ledger) found issues that Part B depends on and that must land before Task 4: symlink/permission-safe config writes (Critical), `emitterSourcePath()` resolution inside the npx bundle (web-driven installs call it), the absolute `node` default, and the redaction gaps. They are fixed in a separate pass tracked in the Part A ledger, not in this plan.

## Deviations from the spec (deliberate)

- **No `/settings/agents` route.** The app has no settings routes; the Configure modal already holds per-tool configuration, so agents get an **AGENTS tab** there (`DocsModal` gains an `initialTab` prop for the banner deep-link). Cost if wrong: one component moves to a page later.
- **Wizard reuse.** `FirstRunWizard` existed but was never mounted; it is reworked in place and mounted on `?setup=1` (which previously just opened the Configure modal).
- **Docker install.** The spec's one-liner is corrected (Task 3): `--host-data-dir` + `--no-db`, and an agent counts as healthy once its first event verifies it.
- **`EMITTER_VERSION` is a content hash** (Task 1), not the rules version.
- **`hooks` block only when there is something to say** (spec §9 implied always-present; omitting it avoids token bloat).
- **Agents without an MCP template** (`windsurf`, `kiro`, `opencode`) do not appear in the configure section's client list; adding MCP config templates for them is out of scope.
- Version bump to 5.1.0 and the CHANGELOG entry happen at release time (`version:sync`), not here; only `rulesVersion` moves (3.0.0 → 3.1.0) because the rules block changed.
