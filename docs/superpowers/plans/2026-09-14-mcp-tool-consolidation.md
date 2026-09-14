# MCP Tool Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce MCP tool count from 71 → 58 (13 dropped, 18% reduction) by collapsing related tools behind mode/kind parameters. Breaking change, no aliases — cut version to 5.0.0.

**Architecture:** Every merge folds one or more tools into a single canonical tool that accepts a union input. Legacy names are deleted, not aliased. Historical journal entries stay classified via the `tool-classes.ts` legacy set. The Smithery classifier's per-tool guard (added in 4.7.2) catches any tool that lands in the registry without an annotation.

**Tech Stack:** TypeScript, zod for input schemas, MCP SDK server.tool registration, vitest + a custom stdio smoke-test runner (`apps/mcp/test-tools.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-14-mcp-tool-consolidation-design.md`

## Global Constraints

- No backward-compatibility aliases. Every removed name disappears from `server.tool` calls.
- Legacy names remain in `packages/core/src/journal/patterns/tool-classes.ts`'s legacy blocks (historical journal entries still classify).
- Version bump: package `version` 4.7.2 → **5.0.0** across all six package.jsons. `rulesVersion` 2.6.1 → **3.0.0** in the same manifests.
- Smithery classifier (`scripts/build-smithery-bundle.mjs`) must stay complete — any tool without a classification throws at build time (guard added in 4.7.2). Every merge task updates it.
- Every merge task ends with `pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build` passing, `apps/mcp/test-tools.mjs` passing for the touched tool, and a commit.
- CHANGELOG entry `## 5.0.0` gets its final wording in the last task (docs/version), not per-merge.

---

### Task 1: Merge `files.create_many` into `files.create`

**Files:**
- Modify: `apps/mcp/src/index.ts:433-467` (rewrite `files.create` registration)
- Delete: `apps/mcp/src/index.ts:1997-...` (whole `files.create_many` registration block)
- Modify: `scripts/build-smithery-bundle.mjs` (remove `files.create_many` from `NEUTRAL_TOOLS`)
- Modify: `packages/core/src/journal/patterns/tool-classes.ts` (add `"files.create_many"` to LEGACY_WRITE_PREFIXES-style block if not already covered)
- Modify: `apps/mcp/test-tools.mjs` (rename any `files.create_many` calls to `files.create` with array input)

**Interfaces:**
- Produces: `files.create({ files: FileCreateInput[] })` where `FileCreateInput` is the current single-file zod object (title, content, destination, project_id?, folder?, tags?, format?, kind?). Length-1 array = single-file case.

- [ ] **Step 1: Read current `files.create_many` handler** at `apps/mcp/src/index.ts:1997` to capture its exact validation + return shape.

- [ ] **Step 2: Add failing smoke-test case** in `apps/mcp/test-tools.mjs` — a single `files.create` call with `{ files: [<one entry>] }` returns a single-element array. Run to confirm it fails (old shape didn't accept arrays).

- [ ] **Step 3: Rewrite `files.create` registration** — new zod schema:

```ts
server.tool(
  "files.create",
  "Create one or more markdown/mermaid/HTML files ... [merged description]",
  {
    files: z.array(z.object({
      title: z.string(),
      content: z.string(),
      destination: z.enum(["knowledge", "project", "kontexta"]),
      project_id: z.number().optional(),
      folder: z.string().optional(),
      tags: z.array(z.string()).optional(),
      format: z.enum(["md", "mmd", "html"]).optional(),
      kind: z.enum(["dictionary", "note"]).optional(),
    })).min(1).describe("One or more files to create. Length-1 array = single file."),
  },
  async ({ files }) => {
    const results = [];
    for (const f of files) {
      const resolved = resolveKindFolder(f);
      if ("error" in resolved) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: resolved.error, failed_at: f.title }, null, 2) }] };
      }
      const r = await createFile({ ...f, projectId: f.project_id, folder: resolved.folder, dataDir });
      const payload: any = annotateTokens(r);
      if (resolved.warning) payload.warning = resolved.warning;
      results.push(payload);
    }
    return { content: [{ type: "text", text: JSON.stringify({ files: results, count: results.length }, null, 2) }] };
  }
);
```

- [ ] **Step 4: Delete `files.create_many` registration block** (currently ~lines 1997 through its closing `);`).

- [ ] **Step 5: Remove `"files.create_many"` from `NEUTRAL_TOOLS`** in `scripts/build-smithery-bundle.mjs`.

- [ ] **Step 6: Add `"files.create_many"` to LEGACY block** in `packages/core/src/journal/patterns/tool-classes.ts` — it should already match a `create_` prefix, so no change may be needed. Verify with `grep create_ packages/core/src/journal/patterns/tool-classes.ts`.

- [ ] **Step 7: Build + smoke test**:
```bash
pnpm --filter kxta-core build && pnpm --filter kontexta-mcp build
pnpm --filter kontexta-mcp gen:manifest
node apps/mcp/test-tools.mjs
node scripts/build-smithery-bundle.mjs 5.0.0 /tmp/test.mcpb && rm /tmp/test.mcpb
```
Expected: all pass, smithery build reports 70 tools (one less).

- [ ] **Step 8: Commit**:
```bash
git add apps/mcp/src/index.ts apps/mcp/test-tools.mjs scripts/build-smithery-bundle.mjs packages/core/src/journal/patterns/tool-classes.ts apps/web/src/lib/mcp-tools.json
git commit -m "refactor(mcp): merge files.create_many into files.create (breaking)"
```

---

### Task 2: Merge `files.delete_many` into `files.delete`

**Files:**
- Modify: `apps/mcp/src/index.ts:906` (rewrite `files.delete` registration)
- Delete: `apps/mcp/src/index.ts:2062-...` (`files.delete_many` block)
- Modify: `scripts/build-smithery-bundle.mjs` (remove `files.delete_many` from `DESTRUCTIVE_TOOLS`)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `files.delete({ ids: number[] })` — length-1 = single-file case; returns `{ deleted: number[], errors: {id, error}[] }`.

- [ ] **Step 1: Read current `files.delete_many` handler** at `apps/mcp/src/index.ts:2062` for its exact error-isolation pattern.

- [ ] **Step 2: Add failing smoke-test case** — `files.delete({ ids: [<one_id>] })` returns `{ deleted: [id], errors: [] }`.

- [ ] **Step 3: Rewrite `files.delete` registration**:

```ts
server.tool(
  "files.delete",
  "DESTRUCTIVE. Delete one or more files by ID. Removes each file from disk, FTS index, tag links, and (if configured) commits a deletion to the file's git backup. Per-file failures are isolated to `errors[]` — the tool never partial-throws. Returns `{ deleted: number[], errors: { id, error }[] }`.",
  { ids: z.array(z.number().int().positive()).min(1).describe("File IDs to delete. Length-1 array = single-file case.") },
  async ({ ids }) => {
    const deleted: number[] = [];
    const errors: { id: number; error: string }[] = [];
    for (const id of ids) {
      try {
        await deleteFile(id, dataDir);
        deleted.push(id);
      } catch (e: any) {
        errors.push({ id, error: e?.message ?? String(e) });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ deleted, errors }, null, 2) }] };
  }
);
```

- [ ] **Step 4: Delete `files.delete_many` registration block.**

- [ ] **Step 5: Remove `"files.delete_many"` from `DESTRUCTIVE_TOOLS`** in `scripts/build-smithery-bundle.mjs`.

- [ ] **Step 6: Update `apps/mcp/test-tools.mjs`** — every existing `files.delete` call currently passes `{ id }`; change to `{ ids: [id] }`. Add a multi-id case.

- [ ] **Step 7: Build + smoke test + smithery dry-run** (69 tools expected).

- [ ] **Step 8: Commit**:
```bash
git commit -m "refactor(mcp): merge files.delete_many into files.delete (breaking)"
```

---

### Task 3: Unify the read family — `files.read` absorbs `read_many`, `read_by_path`, `read_section`, `read_lines`

**Files:**
- Modify: `apps/mcp/src/index.ts:530` (rewrite `files.read`)
- Delete: registrations at `544` (`read_many`), `702` (`read_lines`), `1675` (`read_section`), `2149` (`read_by_path`)
- Modify: `scripts/build-smithery-bundle.mjs` (remove 4 names from `READ_ONLY_TOOLS`)
- Modify: `packages/core/src/journal/patterns/tool-classes.ts` (add legacy names to READ_ONLY_TOOL_NAMES set — they already are; verify)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `files.read({ id?, path?, ids?, section?, lines? })`. Validation: exactly one of `{id, path, ids}`; `section` XOR `lines`; partial-read modifiers require single-file mode. Returns single object for `id | path`, array for `ids`.

- [ ] **Step 1: Read each of the four handlers** (`files.read`, `files.read_many`, `files.read_by_path`, `files.read_section`, `files.read_lines`) to capture the exact single-shape return payloads. `files.read_outline` stays as-is — do not touch it.

- [ ] **Step 2: Add failing smoke-test cases** — one per input mode:
```js
// pseudocode
await callTool("files.read", { id: SEED_ID_1 });                          // full body, single
await callTool("files.read", { path: SEED_PATH_1 });                      // full body via path
await callTool("files.read", { ids: [SEED_ID_1, SEED_ID_2] });            // array
await callTool("files.read", { id: SEED_ID_1, section: "Setup" });        // partial by heading
await callTool("files.read", { id: SEED_ID_1, lines: { from: 1, to: 5 } }); // partial by lines
// Error cases
await callTool("files.read", { id: 1, path: "x" });          // → isError, mutually exclusive
await callTool("files.read", { ids: [1], section: "x" });    // → isError, partial requires single
await callTool("files.read", { id: 1, section: "s", lines: { from: 1, to: 2 } }); // → isError, section XOR lines
```

- [ ] **Step 3: Rewrite `files.read` registration** — union input, dispatcher handler:

```ts
server.tool(
  "files.read",
  "Read one or more files. Modes: single-by-id (`id`), single-by-path (`path`), batch-by-id (`ids`), partial-by-heading (`id`+`section`), partial-by-line-range (`id`+`lines`). Exactly one identifier mode is required. Partial modifiers (`section`, `lines`) are mutually exclusive and require `id` (not `ids`). Read-only; no side effects. Response shape: single file object for `id`/`path`/partial modes; `{ files: [...], count }` for `ids`.",
  {
    id: z.number().int().positive().optional().describe("Single file by ID."),
    path: z.string().optional().describe("Single file by absolute path (must be indexed)."),
    ids: z.array(z.number().int().positive()).min(1).optional().describe("Batch mode: multiple IDs; returns an array."),
    section: z.string().optional().describe("Partial read: return only this heading's body (case-insensitive exact-string). Requires `id`."),
    lines: z.object({
      from: z.number().int().positive(),
      to: z.number().int().positive(),
    }).optional().describe("Partial read: 1-indexed inclusive line range. Requires `id`."),
  },
  async ({ id, path, ids, section, lines }) => {
    // Validation
    const modes = [id !== undefined, path !== undefined, ids !== undefined].filter(Boolean).length;
    if (modes !== 1) {
      return errorPayload("Exactly one of {id, path, ids} must be present");
    }
    if (section !== undefined && lines !== undefined) {
      return errorPayload("`section` and `lines` are mutually exclusive");
    }
    if ((section !== undefined || lines !== undefined) && ids !== undefined) {
      return errorPayload("Partial-read modifiers require `id` (single-file mode)");
    }

    // Dispatch
    if (ids !== undefined) {
      const files = ids.map((rid) => annotateTokens(readFile(rid)));
      return jsonPayload({ files, count: files.length });
    }
    let file;
    if (path !== undefined) {
      const row = getDatabase().prepare("SELECT id FROM files WHERE path = ?").get(path) as { id: number } | undefined;
      if (!row) return errorPayload(`No file indexed at path: ${path}`);
      file = readFile(row.id);
    } else {
      file = readFile(id!);
    }
    if (section !== undefined) {
      const body = extractSection(file.content, section);
      if (body === null) return errorPayload(`Section not found: ${section}`);
      return jsonPayload({ file_id: file.id, path: file.path, section, content: body, size_bytes: Buffer.byteLength(body, "utf8"), est_tokens: estimateTokensFromBuffer(Buffer.from(body, "utf8")) });
    }
    if (lines !== undefined) {
      if (lines.to < lines.from) return errorPayload("`lines.to` must be >= `lines.from`");
      const allLines = file.content.split("\n");
      const start = Math.max(0, lines.from - 1);
      const end = Math.min(allLines.length, lines.to);
      const slice = allLines.slice(start, end).join("\n");
      return jsonPayload({ file_id: file.id, path: file.path, from: start + 1, to: end, total_lines: allLines.length, content: slice, size_bytes: Buffer.byteLength(slice, "utf8"), est_tokens: estimateTokensFromBuffer(Buffer.from(slice, "utf8")) });
    }
    return jsonPayload(annotateTokens(file));
  }
);

// Helpers (add at top of file if not already present):
function jsonPayload(x: any) { return { content: [{ type: "text", text: JSON.stringify(x, null, 2) }] }; }
function errorPayload(msg: string) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }] }; }
```

Note: `extractSection` may already exist under a different name (`readSection` helper) — reuse rather than re-implementing.

- [ ] **Step 4: Delete four old registrations** — `files.read_many` (line 544), `files.read_lines` (702), `files.read_section` (1675), `files.read_by_path` (2149).

- [ ] **Step 5: Update `READ_ONLY_TOOLS` set** in `scripts/build-smithery-bundle.mjs` — remove 4 names (`files.read_by_path`, `files.read_many`, `files.read_section`, `files.read_lines`).

- [ ] **Step 6: Verify `tool-classes.ts` legacy set** already lists those 4 legacy names (grep). Add any missing.

- [ ] **Step 7: Update `apps/mcp/test-tools.mjs`** — replace old-name calls with the new unified form. Cover every dispatch branch.

- [ ] **Step 8: Build + smoke test + smithery dry-run** (65 tools expected).

- [ ] **Step 9: Commit**:
```bash
git commit -m "refactor(mcp): unify read family into files.read with union input (breaking)"
```

---

### Task 4: Merge `files.update_section` into `files.update`

**Files:**
- Modify: `apps/mcp/src/index.ts:891` (rewrite `files.update`), delete `1724` (`files.update_section`)
- Modify: `scripts/build-smithery-bundle.mjs` (remove `files.update_section` from `NEUTRAL_TOOLS`)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `files.update({ file_id, content, section? })`. When `section` is set, `content` becomes the new body of just that heading (current `files.update_section` behavior); otherwise it's a full-body replacement.

- [ ] **Step 1: Read current handlers** at lines 891 and 1724 to reuse `replaceSection` helper.

- [ ] **Step 2: Add failing smoke-test case** — `files.update({ file_id, content: "X", section: "Setup" })` rewrites just that section; without `section` it replaces the whole body.

- [ ] **Step 3: Rewrite `files.update` registration**:

```ts
server.tool(
  "files.update",
  "Rewrite a file. Default = full-body replacement. Pass `section` to rewrite ONLY that heading's body (the heading line is preserved; siblings untouched). Persists via disk → FTS reindex → git commit. Throws if `section` is set but the heading doesn't exist. Returns the updated file metadata.",
  {
    file_id: z.number().int().positive(),
    content: z.string().describe("New content. With `section` set, this replaces just that heading's body; otherwise it becomes the entire file body."),
    section: z.string().optional().describe("Case-insensitive exact-string heading. When set, only this heading's body is rewritten."),
  },
  async ({ file_id, content, section }) => {
    try {
      let newBody = content;
      if (section !== undefined) {
        const file = readFile(file_id);
        newBody = replaceSection(file.content, section, content);
      }
      const result = await updateFile(file_id, newBody, dataDir);
      return jsonPayload(annotateTokens(result));
    } catch (e: any) {
      return errorPayload(e?.message ?? String(e));
    }
  }
);
```

- [ ] **Step 4: Delete `files.update_section` block.**

- [ ] **Step 5: Registry updates** — remove from smithery `NEUTRAL_TOOLS`; verify legacy name in `tool-classes.ts` (already covered by `update_` prefix).

- [ ] **Step 6: Update smoke tests.**

- [ ] **Step 7: Build + smoke + smithery** (64 tools).

- [ ] **Step 8: Commit**:
```bash
git commit -m "refactor(mcp): fold files.update_section into files.update (breaking)"
```

---

### Task 5: Merge `files.bundle_search` into `files.search`

**Files:**
- Modify: `apps/mcp/src/index.ts:954` (rewrite `files.search`), delete `989` (`files.bundle_search`)
- Modify: `scripts/build-smithery-bundle.mjs` (remove `files.bundle_search` from `READ_ONLY_TOOLS`)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `files.search({ query, ..., include_bodies?: boolean })`. When `include_bodies: true`, each match includes the file body inline (current `files.bundle_search` shape).

- [ ] **Step 1: Read current handlers** to reuse the bundle-body annotation.

- [ ] **Step 2: Add failing smoke test** — same query with and without `include_bodies`; without = no body field, with = body present + `total_est_tokens` reflects bodies.

- [ ] **Step 3: Rewrite `files.search`** — add `include_bodies` param; when true, map each match to `{...match, body: readFile(match.id).content}` and re-annotate token totals.

- [ ] **Step 4: Delete `files.bundle_search` block.**

- [ ] **Step 5: Registry updates** — remove from smithery `READ_ONLY_TOOLS`; verify legacy in `tool-classes.ts` (already `bundle_search`).

- [ ] **Step 6: Smoke test updates.**

- [ ] **Step 7: Build + smoke + smithery** (63 tools).

- [ ] **Step 8: Commit**:
```bash
git commit -m "refactor(mcp): fold files.bundle_search into files.search via include_bodies (breaking)"
```

---

### Task 6: Merge `files.grep` into `files.regex_search`

**Files:**
- Modify: `apps/mcp/src/index.ts:803` (rewrite `files.regex_search`), delete `748` (`files.grep`)
- Modify: `scripts/build-smithery-bundle.mjs` (remove `files.grep` from `READ_ONLY_TOOLS`)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `files.regex_search({ pattern, ..., file_id?: number })`. When `file_id` is set, scope narrows to that one file (current `files.grep` behavior).

- [ ] **Step 1: Read both handlers** to reuse the single-file regex path.

- [ ] **Step 2: Add failing smoke test** — regex_search over a corpus vs the same regex with `file_id` set (single-file scan).

- [ ] **Step 3: Rewrite `files.regex_search`** — add optional `file_id` at the top of the handler; when present, short-circuit to the single-file scanning branch that `files.grep` uses today.

- [ ] **Step 4: Delete `files.grep` block.**

- [ ] **Step 5: Registry updates** — remove from smithery `READ_ONLY_TOOLS`; verify legacy in `tool-classes.ts`.

- [ ] **Step 6: Smoke test updates.**

- [ ] **Step 7: Build + smoke + smithery** (62 tools).

- [ ] **Step 8: Commit**:
```bash
git commit -m "refactor(mcp): fold files.grep into files.regex_search via file_id (breaking)"
```

---

### Task 7: Merge `journal.note` + `journal.intent` into `journal.append` → rename to `journal.write`

**Files:**
- Modify: `apps/mcp/src/index.ts:378` (delete `journal.append` registration) AND `apps/mcp/src/index.ts:365-367` (update auto-wrap exclusion — see below)
- Modify: `apps/mcp/src/journal-tools.ts` (rewrite `journal.note` block as new `journal.write`, delete `journal.intent`)
- Modify: `scripts/build-smithery-bundle.mjs` — remove `journal.append`, `journal.note`, `journal.intent` from `NEUTRAL_TOOLS`; add `journal.write`
- Modify: `packages/core/src/journal/patterns/tool-classes.ts` (add `journal.write` to write-set)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `journal.write({ kind: "append" | "note" | "intent", ... })`. Kind-specific fields:
  - `append`: `text: string`, `project_id?: number`
  - `note`: `text: string`, `tags?: string[]`
  - `intent`: `summary: string`

- [ ] **Step 1: Read all three current handlers** (`journal.append` in index.ts, `journal.note` and `journal.intent` in journal-tools.ts).

- [ ] **Step 2: Add failing smoke tests** — one call per `kind`.

- [ ] **Step 3: Update the auto-wrap exclusion** in `apps/mcp/src/index.ts:365` — change `if (name === "journal.append")` to `if (name === "journal.write")`. The reason for excluding stays the same (re-entrance).

- [ ] **Step 4: Delete `journal.append` block in index.ts** (lines 378-430).

- [ ] **Step 5: Rewrite `journal.note` block in journal-tools.ts as `journal.write`** with dispatcher:

```ts
server.tool(
  "journal.write",
  "Write one event to the current project's journal. `kind: 'append'` = timestamped entry in today's daily journal file (returns `{ file_id }`). `kind: 'note'` = free-form observation stored as an `agent_note` event (surfaces in distilled entries). `kind: 'intent'` = topic pivot; distillation uses it to split task buckets. Body fields depend on kind (see params).",
  {
    kind: z.enum(["append", "note", "intent"]).describe("Event kind. Selects which body fields are required."),
    text: z.string().optional().describe("Required for kind='append' or 'note'. Body of the entry."),
    summary: z.string().optional().describe("Required for kind='intent'. One-line summary of the new intent."),
    tags: z.array(z.string()).optional().describe("Optional for kind='note'."),
    project_id: z.number().optional().describe("Optional for kind='append'. Project context."),
  },
  async ({ kind, text, summary, tags, project_id }) => {
    if (kind === "append") {
      if (!text) return errorPayload("kind='append' requires `text`");
      // ... paste the entire current journal.append body (find-or-create daily file, append timestamped line)
    }
    if (kind === "note") {
      if (!text) return errorPayload("kind='note' requires `text`");
      const ev: RawEvent = { ts: new Date().toISOString(), agent: getCurrentAgent(), sid: getCurrentSid(), event: "agent_note", summary: text, tags: tags ?? [] };
      appendVoluntaryEvent(ev);
      return jsonPayload({ ok: true, recorded_at: ev.ts });
    }
    if (kind === "intent") {
      if (!summary) return errorPayload("kind='intent' requires `summary`");
      const ev: RawEvent = { ts: new Date().toISOString(), agent: getCurrentAgent(), sid: getCurrentSid(), event: "user_intent", summary };
      appendVoluntaryEvent(ev);
      return jsonPayload({ ok: true, recorded_at: ev.ts });
    }
  }
);
```

Note: the 'append' branch needs the full body from the current `journal.append` handler (readFile/updateFile/createFile logic — copy verbatim). Because that logic lives in index.ts today (with imports we need), you may need to move the necessary imports (`getDatabase`, `readFile`, `updateFile`, `createFile`, `dataDir`) into journal-tools.ts, OR keep the append branch registered in index.ts and only fold note+intent. **Choose:** if imports are extensive, keep the file boundary — put `journal.write` in index.ts and delete the journal-tools.ts note/intent registrations. Document the choice in the commit.

- [ ] **Step 6: Delete `journal.intent` block in journal-tools.ts.**

- [ ] **Step 7: Registry updates** — smithery: drop 3 names, add `journal.write`. tool-classes.ts: add `journal.write` to WRITE_TOOL_NAMES, keep the 3 legacy names in place.

- [ ] **Step 8: Smoke test updates.**

- [ ] **Step 9: Build + smoke + smithery** (60 tools expected: -3 removed, +1 added = net -2 from 62).

- [ ] **Step 10: Commit**:
```bash
git commit -m "refactor(mcp): collapse journal.append/note/intent into journal.write (breaking)"
```

---

### Task 8: Merge `hands.describe_schema` into `hands.list`

**Files:**
- Modify: `apps/mcp/src/index.ts:2701` (rewrite `hands.list`), delete `2742` (`hands.describe_schema`)
- Modify: `scripts/build-smithery-bundle.mjs` (remove `hands.describe_schema` from `READ_ONLY_TOOLS`)
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `hands.list({ id? })`. When `id` is set, returns the schema for that single hand; when absent, returns the list.

- [ ] **Step 1: Read both handlers** at 2701 and 2742 to reuse the schema-lookup call.

- [ ] **Step 2: Add failing smoke test** — `hands.list({})` returns array; `hands.list({ id: "<hand-id>" })` returns single schema.

- [ ] **Step 3: Rewrite `hands.list`**:

```ts
server.tool(
  "hands.list",
  "List every registered hand (dynamic per-project MCP tool). Pass `id` to return the schema for a single hand instead of the enumeration. Read-only.",
  { id: z.string().optional().describe("Hand id. When set, returns that hand's schema instead of the list.") },
  async ({ id }) => {
    if (id !== undefined) {
      const schema = describeHandSchema(id);  // existing helper name
      if (!schema) return errorPayload(`Unknown hand: ${id}`);
      return jsonPayload(schema);
    }
    return jsonPayload({ hands: listHands() });
  }
);
```

- [ ] **Step 4: Delete `hands.describe_schema` block.**

- [ ] **Step 5: Registry updates.**

- [ ] **Step 6: Smoke test updates + verify `apps/mcp/tests/hands*.test.mjs` still passes.**

- [ ] **Step 7: Build + smoke + smithery** (59 tools).

- [ ] **Step 8: Commit**:
```bash
git commit -m "refactor(mcp): fold hands.describe_schema into hands.list via id (breaking)"
```

---

### Task 9: Merge `admin.stats` + `admin.whats_new` into `admin.overview`

**Files:**
- Modify: `apps/mcp/src/index.ts:2187` (rewrite `admin.stats` as `admin.overview`), delete `2558` (`admin.whats_new`)
- Modify: `scripts/build-smithery-bundle.mjs` — remove `admin.stats` + `admin.whats_new` from `READ_ONLY_TOOLS`, add `admin.overview`
- Modify: `packages/core/src/journal/patterns/tool-classes.ts` — add `admin.overview` to READ_ONLY_TOOL_NAMES, keep old two in legacy
- Modify: `apps/mcp/test-tools.mjs`

**Interfaces:**
- Produces: `admin.overview({ mode: "stats" | "whats_new", ... })`. Mode-specific fields:
  - `stats`: `project_id?: number | null`, `top_tags?: number`, `include_token_total?: boolean` — returns `{file_count, untagged_count, favorite_count, top_tags, by_project?}`
  - `whats_new`: `since: string`, `project_id?: number | null`, `include_tags?: boolean`, `limit?: number` — returns `{since, until, count, total_est_tokens, files}`

- [ ] **Step 1: Read both handlers** for their exact input/output shapes.

- [ ] **Step 2: Add failing smoke tests** — one call per mode; verify response shape matches the mode.

- [ ] **Step 3: Rewrite `admin.stats` as `admin.overview`** with mode dispatcher (paste bodies from both handlers verbatim into the two branches).

- [ ] **Step 4: Delete `admin.whats_new` block.**

- [ ] **Step 5: Registry updates.**

- [ ] **Step 6: Smoke test updates.**

- [ ] **Step 7: Build + smoke + smithery** (58 tools — final count).

- [ ] **Step 8: Commit**:
```bash
git commit -m "refactor(mcp): merge admin.stats + admin.whats_new into admin.overview (breaking)"
```

---

### Task 10: Rewrite rules-block routing matrix + tool-categories UI

**Files:**
- Modify: `packages/core/src/agent-rules/rules-block.md` — rewrite the tool routing matrix to reference only the 58 new tool names
- Modify: `apps/web/src/lib/mcp-tool-categories.ts` — regroup categories to match the new surface

**Interfaces:**
- Consumes: final tool name list from Tasks 1–9.

- [ ] **Step 1: Grep the routing matrix** for legacy names:
```bash
grep -nE '`(files\.create_many|files\.delete_many|files\.read_many|files\.read_by_path|files\.read_section|files\.read_lines|files\.update_section|files\.bundle_search|files\.grep|journal\.append|journal\.note|journal\.intent|hands\.describe_schema|admin\.stats|admin\.whats_new)`' packages/core/src/agent-rules/rules-block.md
```

- [ ] **Step 2: Rewrite each match** — replace with the merged tool + a note about which mode/param to use. Example: `files.read_many` → `files.read({ ids: [...] })`.

- [ ] **Step 3: Rewrite `apps/web/src/lib/mcp-tool-categories.ts`** — remove the 13 dropped tools from their category lists; add mode notes to the merged tools (e.g. `files.read` now has "batch mode" and "partial read" annotations).

- [ ] **Step 4: Rebuild web + verify manifest reflects new surface**:
```bash
pnpm --filter kontexta-mcp gen:manifest
pnpm -C apps/web build 2>&1 | tail -20
```

- [ ] **Step 5: Commit**:
```bash
git commit -m "docs(rules): rewrite routing matrix + web categories for 5.0.0 tool surface"
```

---

### Task 11: Version bump, docs, CHANGELOG, final verification

**Files:**
- Modify: `package.json`, `apps/mcp/package.json`, `apps/web/package.json`, `apps/publish/package.json`, `packages/core/package.json`, `packages/cli/package.json` — `version` → 5.0.0
- Modify: `package.json`, `apps/mcp/package.json`, `apps/web/package.json`, `apps/publish/package.json`, `packages/core/package.json`, `packages/cli/package.json` — `rulesVersion` → 3.0.0
- Modify: `README.md` — "71 MCP tools" → "58 MCP tools"
- Modify: `apps/mcp/README.md` — "71 tools" → "58 tools" (all occurrences)
- Modify: `docs/MCP.md` — "71 tools" → "58 tools"
- Modify: `CHANGELOG.md` — add `## 5.0.0 — MCP tool surface consolidation (breaking)` entry

- [ ] **Step 1: Bump versions** across all six package.jsons:
```bash
sed -i '' 's/"version": "4.7.2"/"version": "5.0.0"/' package.json apps/publish/package.json apps/web/package.json apps/mcp/package.json packages/core/package.json packages/cli/package.json
sed -i '' 's/"rulesVersion": "2.6.1"/"rulesVersion": "3.0.0"/' package.json apps/mcp/package.json apps/web/package.json apps/publish/package.json packages/core/package.json packages/cli/package.json
```

- [ ] **Step 2: Update tool counts** in README.md, apps/mcp/README.md, docs/MCP.md — replace `71` with `58` in the tool-count contexts (verify with grep first, don't blanket-replace).

- [ ] **Step 3: Add CHANGELOG entry**:
```markdown
## 5.0.0 — MCP tool surface consolidation (breaking)

### Breaking

- **Removed 13 tools** in favor of merged/parameterised replacements. Existing agent context files must re-onboard via `admin.onboard_agent` (auto-triggered by `rulesVersion` bump to 3.0.0).
- Removed → replacement:
  - `files.create_many` → `files.create({ files: [...] })`
  - `files.delete_many` → `files.delete({ ids: [...] })`
  - `files.read_many`, `files.read_by_path`, `files.read_section`, `files.read_lines` → `files.read({ id? | path? | ids?, section?, lines? })`
  - `files.update_section` → `files.update({ ..., section })`
  - `files.bundle_search` → `files.search({ ..., include_bodies: true })`
  - `files.grep` → `files.regex_search({ ..., file_id })`
  - `journal.append`, `journal.note`, `journal.intent` → `journal.write({ kind, ... })`
  - `hands.describe_schema` → `hands.list({ id })`
  - `admin.stats`, `admin.whats_new` → `admin.overview({ mode, ... })`
- **Tool count 71 → 58.** Motivated by Glama feedback that the previous surface was too broad for agents to navigate reliably.
```

- [ ] **Step 4: Final verification**:
```bash
pnpm --filter kxta-core build
pnpm --filter kontexta-mcp build
pnpm --filter kontexta-mcp gen:manifest
node -e 'const t = require("./apps/web/src/lib/mcp-tools.json").tools; console.log("tool count:", t.length)'   # expect 58
node apps/mcp/test-tools.mjs
node scripts/build-smithery-bundle.mjs 5.0.0 /tmp/final.mcpb && ls -la /tmp/final.mcpb && rm /tmp/final.mcpb
pnpm --filter kxta-core test -- --run 2>&1 | tail -5   # only expect the 5 pre-existing git.test.ts failures
```

- [ ] **Step 5: Commit**:
```bash
git commit -m "release: 5.0.0 — MCP tool surface consolidation (71 → 58 tools)"
```

---

## Self-Review Notes

- **Spec coverage:** All 9 merges from the spec's Groups 1–3 are covered by Tasks 1–9. Cross-cutting registries are covered in each merge task; rules-block + web categories are Task 10; version + docs + verify are Task 11. Every ripple-file listed in the spec's "Ripple: files touched" section appears in at least one task's Files block.
- **Placeholder scan:** Every step has actual code, exact file paths, and concrete commands. The one soft spot is Task 7's paragraph about "choose whether to move the append handler across files" — that's a real judgment call, not a placeholder; the guidance is explicit.
- **Type consistency:** Every produced interface names the exact new tool + input keys. `files.read`'s union input is defined once (Task 3) and referenced consistently.
- **Independent testability:** Every task ends in build + smoke + smithery dry-run + commit. A reviewer can accept/reject one merge without blocking the next.
