# Storage Sync Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two or more machines syncing through the storage server converge on the same content, with a conflict record on every machine whenever an edit lost, and never lose a local edit silently.

**Architecture:** The op model (gid, kind, origin, base_version, payload), the outbox, the server's per-gid version counter and the Conflict Manager all stay. This plan fixes how the client decides `base_version` (captured when the edit is made), how the pull treats ops that collide with local state (fork a copy instead of overwrite, including on the machine that lost the push), how files are matched (by gid only, never by path), and seals the watcher and the server's enrollment route.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Hono (server), chokidar (watcher). Monorepo with pnpm.

**Spec:** The second code review of commit `a181383` (ten findings, listed in each task) plus the three conflict-model proposals the user accepted in conversation: the loser of a conflict forks too, every resolution enqueues an op, conflict-flagged deletes are not applied. The brains design `docs/superpowers/specs/2026-10-30-brains-design.md` depends on this plan being done first and lists the guarantees it assumes in its "Depends on" line.

## Global Constraints

- One-line comments only; no em dashes anywhere in code, comments, docs or commit messages.
- Commit messages have no `Co-Authored-By` trailer.
- Do not bump any package version or `rulesVersion` here; the brains plan ships both as 7.0.0 and folds the 6.2.0 changelog entry into it.
- `packages/storage-server` has no `node_modules` until Task 0 runs `pnpm install`; roundtrip tests import it.
- Tests that touch files must set `process.env.KONTEXTA_DATA_DIR` to their temp dir and call `resetDataDirCache()` (from `src/util/paths.js`) in `beforeEach` and `afterEach`; `resolveSyncPath` refuses anything outside the data dir.
- Payload shapes are the portable ones from 6.2.0: `rel_path`, `rel_from`/`rel_to`, `project_gid`, `entity_gid`, no local integer ids.

## Review Focus

Failure modes the review implies but no single task's happy path exercises. Each has a pinned test in the owning task:

1. Two machines both press "keep-server" on the same conflict (Task 4): both must enqueue an op so the server sees one winner; the test asserts both machines end with identical content after one more sync round.
2. A pull applies three ops where the second fails transiently (Task 2): the first op's version is recorded, the second's is not, the third is not reached; after the retry the versions equal the server's.
3. A conflict copy is edited by the user in their editor (Task 6): the watcher must still ignore it (no `file.update` enqueued), and the Conflict Manager must still find it by `conflict_path`.
4. A file created locally in a project repo (outside the data dir) and then moved (Task 7): neither the create nor the move enqueues an op, and the local DB row still updates.
5. A machine re-registers with the right secret after a lost token (Task 8): the server must still return `token: null` (re-issue is the brains design's job), but only after the secret check passed.

---

### Task 0: Workspace install and CI for the server package

**Files:**
- Modify: `.github/workflows/test-pr.yml` (the job that runs `pnpm test` or the per-package test commands)
- Modify: `pnpm-lock.yaml` (regenerated)

**Interfaces:**
- Produces: `packages/storage-server/node_modules` present so `packages/core/tests/storage/roundtrip.test.ts` and `conflict-order.test.ts` resolve `../storage-server/src/*` without a symlink.

- [ ] **Step 1: Install**

Run: `pnpm install`
Expected: `packages/storage-server/node_modules/hono` exists; lockfile diff touches only the storage-server importer.

- [ ] **Step 2: Run the two roundtrip suites**

Run: `cd packages/core && npx vitest run tests/storage/roundtrip.test.ts tests/storage/conflict-order.test.ts`
Expected: PASS (no "Cannot find package '@hono/node-server'").

- [ ] **Step 3: Add the server tests to CI**

In `test-pr.yml`, where core tests run, add `pnpm --filter kontexta-storage-server test` (check the package `name` in `packages/storage-server/package.json` and use it verbatim).

- [ ] **Step 4: Commit**

```bash
git add pnpm-lock.yaml .github/workflows/test-pr.yml
git commit -m "ci: install storage-server in the workspace and run its tests"
```

---

### Task 1: Capture `base_version` when the edit is enqueued

Findings fixed: review #2 (send-time rewrite launders stale edits), review #10 (one SELECT per op).

**Files:**
- Create: `packages/core/src/storage/versions.ts`
- Modify: `packages/core/src/storage/outbox.ts:76-95` (`enqueueOp`)
- Modify: `packages/core/src/storage/client.ts:455-475` (base rewrite in `pushOutbox`), remove the private `knownGidVersion`/`recordGidVersion` there and import from `versions.ts`
- Modify: `packages/core/src/storage/index.ts` (export `versions.js`)
- Test: `packages/core/tests/storage/versions.test.ts` (new), `packages/core/tests/storage/client.test.ts` (`rewrites base_version at send time ...` and `continues the base_version chain ...` change meaning; rewrite them)

**Interfaces:**
- Produces, in `versions.ts`:
  - `knownGidVersion(db: Database, gid: string): number` (0 when unknown)
  - `knownGidVersions(db: Database, gids: string[]): Map<string, number>` (one `IN (...)` query, chunked at 500)
  - `recordGidVersion(db: Database, gid: string, version: number): void` (monotonic upsert into `gid_versions`)
- Changes: `enqueueOp` stores `base_version = null` when the caller passed `null`, otherwise `knownGidVersion(db, op.gid)`. Callers keep passing `0` as the "mutation" marker; the stored value is the real base.
- Changes: `pushOutbox` sends `wireBase = stored base_version + same-batch predecessors for the gid`, with `null` kept as `null` only when there are no predecessors. It no longer reads `gid_versions` at send time.

- [ ] **Step 1: Write failing tests**

`tests/storage/versions.test.ts`:
```ts
it("knownGidVersions returns 0 for unknown gids and the stored version otherwise", ...)
it("recordGidVersion never lowers a version", ...)
```
`tests/storage/outbox.test.ts`, add:
```ts
it("enqueueOp stores the gid's known version as base_version for a mutation and keeps null for a create", () => {
  recordGidVersion(db, "7@aaaaaaaaaaaaaaaa", 3);
  const id = enqueueOp(db, op({ gid: "7@aaaaaaaaaaaaaaaa", kind: "file.update", base_version: 0 }));
  expect(row(id).base_version).toBe(3);
  const c = enqueueOp(db, op({ gid: "8@aaaaaaaaaaaaaaaa", kind: "file.create", base_version: null }));
  expect(row(c).base_version).toBeNull();
});
```
`tests/storage/client.test.ts`, replace the two send-time tests with:
```ts
it("sends the base_version captured at enqueue time even if a pull advanced the gid since", async () => {
  recordGidVersion(db, G, 3);
  const id = enqueueOp(db, validOp(1, { gid: G, kind: "file.update", base_version: 0 }));
  recordGidVersion(db, G, 4); // a pull landed in between
  await pushOutbox(db, { fetchImpl });
  expect(sentBody()[0].base_version).toBe(3);
});
it("adds same-batch predecessors to the captured base", ...) // two edits enqueued at v3 go out as 3 and 4
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/storage/versions.test.ts tests/storage/outbox.test.ts tests/storage/client.test.ts`
Expected: FAIL (`versions.js` not found; base_version 4 instead of 3).

- [ ] **Step 3: Implement `versions.ts`, change `enqueueOp`, change `pushOutbox`**

`pushOutbox` builds `wire` from the stored `base_version` only; delete the `knownGidVersion(db, r.gid)` call in the map. Keep `recordGidVersion(db, gid, r.version ?? knownGidVersion(db, gid) + 1)` on ack, but take `knownGidVersions` once for the batch before the loop.

- [ ] **Step 4: Run the full storage suite**

Run: `cd packages/core && npx vitest run tests/storage && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/storage packages/core/tests/storage
git commit -m "fix(storage): capture base_version at enqueue time, batch version lookups"
```

---

### Task 2: Record a pulled op's version only after it applied or was skipped

Finding fixed: review #4.

**Files:**
- Modify: `packages/core/src/storage/client.ts` (`pullRemoteOps` row loop, currently records at the top of the loop)
- Test: `packages/core/tests/storage/client.test.ts`

**Interfaces:**
- Consumes: `recordGidVersion` from Task 1.
- Behaviour: own-origin rows record immediately (they were applied locally when made). Other rows record after `applyRemoteOp` or `forkConflictFromOp` returns, or after `recordApplyFailure` returned `true` (skipped). A retried failure records nothing.

- [ ] **Step 1: Write failing test (Review Focus 2)**

```ts
it("does not record the gid version of an op whose apply failed transiently", async () => {
  // rows: seq1 gid A v1 ok, seq2 gid B v1 throws once (fake lock timeout), seq3 gid C v1
  const first = await pullRemoteOps(db, { fetchImpl });
  expect(first.error).toMatch(/seq 2/);
  expect(version(A)).toBe(1); expect(version(B)).toBe(0); expect(version(C)).toBe(0);
  const second = await pullRemoteOps(db, { fetchImpl }); // apply succeeds now
  expect(second.error).toBeNull();
  expect([version(A), version(B), version(C)]).toEqual([1, 1, 1]);
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: `version(B)` is 1 after the first pull.

- [ ] **Step 3: Move the `recordGidVersion` call**

- [ ] **Step 4: Run `tests/storage/client.test.ts`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(storage): record pulled gid versions only after a successful apply or skip"
```

---

### Task 3: The machine that lost a conflict forks too; flagged deletes are not applied

Findings fixed: review #1 (loser overwrites its own edit), reviewer-accepted proposal on `file.delete`.

**Files:**
- Create: `packages/core/src/db/migrations/017-lost-push.sql` (`ALTER TABLE gid_versions ADD COLUMN lost_push INTEGER NOT NULL DEFAULT 0`, guarded the way earlier migrations guard added columns)
- Modify: `packages/core/src/storage/versions.ts` (add `markLostPush(db, gid)`, `clearLostPush(db, gid)`, `hasLostPush(db, gid): boolean`)
- Modify: `packages/core/src/storage/client.ts` (`pushOutbox` ack loop; `pullRemoteOps` apply branch; `forksCanonicalContent`)
- Test: `packages/core/tests/storage/client.test.ts`, `packages/core/tests/storage/roundtrip.test.ts`

**Interfaces:**
- Produces: `shouldForkInsteadOfApply(db: Database, op: Op, status: string): boolean` in `client.ts`, replacing `forksCanonicalContent`. True when `op.kind` is `file.create` or `file.update`, the gid has a local `files` row, and either `status === "conflict"` or `hasLostPush(db, op.gid)` or the outbox has an unacked (`pending`/`sent`/`failed`) content op for the gid.
- Behaviour: `pushOutbox` calls `markLostPush` for every content op the server flagged `conflict`. `pullRemoteOps` calls `clearLostPush` after it forks for that gid. A `file.delete` row with `status === "conflict"` is not applied; it is pushed to `conflicts` and counted as applied (cursor moves on).

- [ ] **Step 1: Write failing tests**

`client.test.ts`:
```ts
it("forks the accepted remote op when this machine's own push for the gid was flagged conflict", async () => {
  // local file G with content "mine"; push returns status conflict for it
  await pushOutbox(db, { fetchImpl: conflictAck });
  // pull serves B's accepted update of G with "theirs" (gid_version 2)
  const res = await pullRemoteOps(db, { fetchImpl: serveGet([remoteRow(1, G, { status: "accepted", content: "theirs", gid_version: 2 })]) });
  expect(readFileSync(localPath(G), "utf8")).toBe("mine");
  expect(countUnresolvedConflicts(db)).toBe(1);
  expect(res.conflicts.length).toBe(1);
});
it("forks when a pending local content op exists for the gid even without a prior push", ...)
it("does not apply a conflict-flagged file.delete and keeps the local file", ...)
```
`roundtrip.test.ts`:
```ts
it("both machines keep their own edit and both see a conflict after a concurrent edit", async () => {
  // A and B both at v1; B pushes first; A pushes then pulls
  expect(fileOn(A)).toBe("A's text"); expect(fileOn(B)).toBe("B's text");
  expect(conflictsOn(A)).toBe(1); expect(conflictsOn(B)).toBe(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: A's file reads "theirs"; `countUnresolvedConflicts` is 0.

- [ ] **Step 3: Add the migration, the three `versions.ts` functions, `shouldForkInsteadOfApply`, the delete branch**

- [ ] **Step 4: Run storage tests**

Run: `cd packages/core && npx vitest run tests/storage && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/tests
git commit -m "fix(storage): fork on the losing machine too; never apply a conflict-flagged delete"
```

---

### Task 4: Every resolution enqueues an op

Finding fixed: review #1's second half (two keep-server resolutions diverge forever).

**Files:**
- Modify: `packages/core/src/storage/conflicts.ts:696-740` (`keep-server` branch)
- Test: `packages/core/tests/storage/conflicts.test.ts`, `packages/core/tests/storage/roundtrip.test.ts`

**Interfaces:**
- Behaviour: `keep-server` enqueues a `file.update` with the remote content, `rel_path`, and `base_version: 0` (Task 1 turns that into the current known version, which already includes the conflict op's version because the machine pulled it). `ResolveConflictResult.outboxOpId` is set for all four strategies.

- [ ] **Step 1: Write failing tests (Review Focus 1)**

`conflicts.test.ts`:
```ts
it("keep-server enqueues a file.update carrying the remote content", ...)
```
`roundtrip.test.ts`:
```ts
it("converges when both machines resolve the same conflict with keep-server", async () => {
  // after the Task 3 scenario, both resolve keep-server, then two sync rounds each
  expect(fileOn(A)).toBe(fileOn(B));
  expect(conflictsOn(A) + conflictsOn(B)).toBe(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: `outboxOpId` null for keep-server; files differ.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run `tests/storage/conflicts.test.ts tests/storage/roundtrip.test.ts`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(storage): keep-server resolution is a sync event too"
```

---

### Task 5: Match files by gid only; same-path collisions become conflicts

Findings fixed: review #3 (path match hijacks a different gid's row), review #9 (`file.delete` resolves `existing.path` needlessly).

**Files:**
- Modify: `packages/core/src/storage/apply.ts` (`applyFileCreate`, `applyFileUpdate`, `applyFileDelete`, `applyFileMove` lookups)
- Modify: `packages/core/src/storage/conflicts.ts` (`resolveConflict` for path conflicts; add `conflict_kind` column to `ensureConflictsTable`: `'content' | 'path'`, default `'content'`, added with the same guarded `ALTER` pattern)
- Test: `packages/core/tests/storage/apply.test.ts`, `packages/core/tests/storage/conflicts.test.ts`

**Interfaces:**
- Produces: `registerPathConflict(input: { remoteOp: Op; localFileId: number; localPath: string; remoteContent: string }, db?): ConflictRecord` in `conflicts.ts`. Writes the conflict copy next to `localPath`, inserts a `conflicts` row with `gid = remoteOp.gid`, `conflict_kind = 'path'`, `file_path = localPath`.
- Behaviour in `apply.ts`: lookups use `WHERE gid = ?` only. For `file.create`/`file.update`, if no row matches the gid but a row with a different gid owns the resolved path, call `registerPathConflict` and return without touching the row or the file. `file.delete` with no gid match does nothing (it never deletes by path). `applyFileDelete` no longer calls `resolveSyncPath(existing.path)`.
- Behaviour in `resolveConflict` for `conflict_kind = 'path'`:
  - `keep-server`: local row takes the remote content and adopts the remote gid (`UPDATE files SET gid = ?, content_hash = ?`), enqueues `file.delete` for the old local gid, then `file.update` for the adopted gid.
  - `keep-mine` and `keep-both`: the conflict copy becomes a real file: insert a `files` row with the remote gid at the copy's path, FTS it, enqueue `file.move` for the remote gid to that path (`rel_from` = local path, `rel_to` = copy path). The copy file is not deleted.
  - `merged`: as `keep-server` but with the merged content.

- [ ] **Step 1: Write failing tests**

`apply.test.ts`:
```ts
it("file.create for a new gid at an occupied path registers a path conflict and leaves the local file alone", ...)
it("file.update never matches a row by path", ...)
it("file.delete with no gid match deletes nothing even if the path exists", ...)
```
`conflicts.test.ts`:
```ts
it("keep-server on a path conflict adopts the remote gid and enqueues delete(old gid) then update(new gid)", ...)
it("keep-mine on a path conflict turns the copy into a tracked file and enqueues file.move for the remote gid", ...)
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run `tests/storage`**

Expected: PASS. The two-process and roundtrip suites must still pass; they create files by gid.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(storage): match remote file ops by gid only; same-path collisions become conflicts"
```

---

### Task 6: The watcher ignores conflict copies

Finding fixed: review #5.

**Files:**
- Modify: `packages/core/src/watcher/index.ts:107` (`ignored` predicate) and the add/change handlers
- Modify: `packages/core/src/storage/conflicts.ts` (export `isConflictCopyPath(p: string): boolean`)
- Test: `packages/core/tests/storage/watcher-outbox.test.ts`

**Interfaces:**
- Produces: `isConflictCopyPath(p)` true when `basename(p)` matches `/ \(from [^()]+\)(\.[^.]+)?$/` (the `buildConflictPath` shape, with or without the timestamp suffix).
- Behaviour: the watcher's `ignored` predicate returns true for such paths, so no row, no FTS entry and no op is created for them, and user edits to a copy (Review Focus 3) enqueue nothing. `resolveConflict` keeps finding copies by `conflict_path`.

- [ ] **Step 1: Write failing test (Review Focus 3)**

```ts
it("a conflict copy appearing or changing on disk enqueues no op and creates no files row", async () => {
  writeFileSync(join(kb, "note (from laptop).md"), "x");
  await settle();
  writeFileSync(join(kb, "note (from laptop).md"), "y");
  await settle();
  expect(pendingCount(db)).toBe(0);
  expect(db.prepare("SELECT COUNT(*) n FROM files WHERE path LIKE '%(from laptop)%'").get().n).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run `tests/storage/watcher-outbox.test.ts tests/storage/conflicts.test.ts`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(watcher): never index or sync conflict copies"
```

---

### Task 7: Portable watcher payloads; project-repo files never produce file ops; drop the legacy path fallback

Findings fixed: review #6 (watcher payload shape), review #8 (`/knowledge/` fallback re-roots repo files).

**Files:**
- Modify: `packages/core/src/watcher/index.ts:220-330` (three ops)
- Modify: `packages/core/src/files/index.ts` (`enqueueFileOp` and the four call sites)
- Modify: `packages/core/src/storage/paths.ts` (`resolveSyncPath`: delete the `/knowledge/` branch)
- Test: `packages/core/tests/storage/watcher-outbox.test.ts`, `files-outbox.test.ts`, `apply.test.ts` (remove the "legacy absolute origin path is re-rooted" test)

**Interfaces:**
- Produces: `isSyncablePath(absPath: string): boolean` in `paths.ts` (`toRelPath(absPath) !== null`).
- Behaviour: `enqueueFileOp` (files) and `enqueueWatcherOp` (watcher) return without enqueuing when the op is a `file.*` kind and the payload's `path` (or `from` for a move) is not syncable. Watcher ops carry `rel_path`, `project_gid` (via `gidOfRow("projects", projectId)`), and no `project_id`. `resolveSyncPath` without `rel_path` accepts only an absolute path already inside the data dir.

- [ ] **Step 1: Write failing tests (Review Focus 4)**

```ts
it("watcher file.create carries rel_path and project_gid and no project_id", ...)
it("creating then moving a file inside a project repo enqueues no file ops but updates the files row", ...)
it("resolveSyncPath rejects an absolute path outside the data dir even if it contains /knowledge/", ...)
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run `tests/storage tests/files`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(storage): portable watcher payloads; repo files do not sync; drop legacy path fallback"
```

---

### Task 8: Server enrollment: secret check before any lookup

Finding fixed: review #7.

**Files:**
- Modify: `packages/storage-server/src/routes/ops.ts:296-330` (`POST /clients`)
- Test: `packages/storage-server/tests/server.test.ts` (`POST /clients enrollment` block)

**Interfaces:**
- Behaviour: the enrollment-secret check runs first for every `POST /clients`. Without a valid secret the response is `403` with the same body for known and unknown machine ids. With a valid secret, a known machine still gets `{ registered: false, token: null }` (Review Focus 5) and its hostname is refreshed; an unknown one is enrolled.

- [ ] **Step 1: Write failing tests**

```ts
it("re-registration without the secret is 403 and does not change the hostname", ...)
it("responses for known and unknown machine ids are identical without the secret", ...)
it("re-registration with the secret refreshes the hostname and returns token null", ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter <storage-server package name> test`

- [ ] **Step 3: Move the check above `isClientKnown`**

- [ ] **Step 4: Run the server tests and `npx tsc --noEmit` in the package**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(storage-server): check the enrollment secret before any client lookup"
```

---

### Task 9: Whole-suite verification and changelog line

**Files:**
- Modify: `CHANGELOG.md` (under the top entry, currently `## 6.2.0`, `### Fixed`, one bullet per task 1 to 8 in the existing voice; the brains plan renames that entry to 7.0.0)

- [ ] **Step 1: Run everything**

Run, from the repo root:
```
cd packages/core && npx vitest run && npx tsc --noEmit -p . && npm run build && cd ../..
cd packages/cli && npx vitest run && cd ../..
cd apps/mcp && npx tsc --noEmit && cd ../..
cd apps/web && npx vitest run && cd ../..
pnpm --filter <storage-server package name> test
```
Expected: all PASS.

- [ ] **Step 2: Changelog**

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the storage sync fixes"
```
