# History Rewrite — Plan and Script Guide

Goal: replace the current 164-commit messy history with ~20–25 commits that tell a dependency-respecting incremental story, where each commit builds on the previous and (ideally) compiles standalone.

This document is the **plan**, not the rewrite itself. Run nothing here without reading the "Risks & Rollback" section first.

---

## 1. Why rewrite

Current history (`git log --oneline | wc -l` = 164) is the result of an extraction from a private monolith plus normal branch chaos: merges into `develop`, version bumps, fix-merge-conflict commits, "Release vX.Y.Z" PR squashes. It does not narrate how the system was built. A new reader cannot follow it.

We rewrite to produce a **didactic history**: each commit answers "what's the next layer?" and a reader stepping through them learns the architecture in order.

---

## 2. The dependency graph (ground truth)

Verified from `pnpm-workspace.yaml` and the per-package `package.json` files:

```
packages/core   ← apps/mcp   ← apps/web
                              ↑
                        (web also imports core)
```

Inside `packages/core/src`:

| Subsystem        | Depends on                  | Role                                  |
|------------------|-----------------------------|---------------------------------------|
| `util/`          | (nothing internal)          | Pure helpers, types                   |
| `db/`            | `util`                      | SQLite + FTS5 setup, migrations       |
| `files/`         | `db`, `util`                | Markdown vault read/write             |
| `git/`           | `files`, `util`             | Git-backed sync                       |
| `metadata/`      | `db`, `files`               | est_tokens / size_bytes accounting    |
| `bundle/`        | `files`, `metadata`         | Surgical section reads                |
| `clip/`          | `files`, `util`             | Web clipping                          |
| `watcher/`       | `files`, `db`               | FS watch + reindex                    |
| `whats-new/`     | `db`, `files`               | Diff-against-disk + change feed       |
| `project-map/`   | `db`, `git`                 | Project registration                  |
| `agent-rules/`   | `files`, `project-map`      | Onboard CLAUDE.md / AGENTS.md / etc.  |
| `db/migrations/` | `db`                        | Schema evolution                      |

Inside `apps/mcp/src`:

| Module    | Depends on             | Role                              |
|-----------|------------------------|-----------------------------------|
| `index`   | core (most subsystems) | MCP server entry, tool registry   |
| `hands/`  | `util`                 | Sandboxed command engine          |

`apps/web` is the dashboard; depends on core (read APIs) and the built `kontexta-mcp` for some routes.

This graph is the **commit ordering constraint**: a layer may only be introduced after its dependencies.

---

## 3. The target storyline

Target commit sequence (~22 commits). Each commit's tree should compile up through that commit (the verification gate enforces this).

```
01  chore: repo skeleton (pnpm workspace, tsconfig, license, gitignore, turbo)
02  chore: shared util types and helpers (packages/core/src/util)
03  feat(core/db): SQLite schema + FTS5 setup, migrations runner
04  feat(core/files): markdown vault read/write
05  feat(core/git): git-backed sync of the vault
06  feat(core/metadata): token + size accounting
07  feat(core/bundle): surgical section read API
08  feat(core/clip): web clipping with auth-wall detection
09  feat(core/watcher): filesystem watcher + incremental reindex
10  feat(core/whats-new): change feed and diff-against-disk
11  feat(core/project-map): project registration + per-project state
12  feat(core/agent-rules): inject ctx rules into CLAUDE/AGENTS/GEMINI/Cursor
13  test(core): unit tests for the 12 subsystems above
14  feat(mcp/hands): sandboxed command engine, ReDoS-proof validation
15  feat(mcp): MCP server, tool registry wiring core → MCP tools
16  test(mcp): hands sandbox + tool integration tests
17  feat(web): Next.js dashboard scaffold + layout
18  feat(web/api): read/upload/export API routes
19  feat(web/docs): in-app docs builder for the 47-tool catalogue
20  feat(web/hands-config): form-based kontexta.json editor
21  chore(release): Dockerfile, docker-compose, CI workflows
22  docs: README, CONTRIBUTING, NOTICE, CHANGELOG seed
```

Tweak counts as you like — the contract is "each commit is a coherent layer that depends only on prior commits."

---

## 4. Strategy options (and the recommendation)

Three viable approaches:

### A. Cherry-pick + reorder existing commits
Use `git rebase -i` to reorder, squash, drop. Preserves original authors/dates per commit.
- **Pros:** keeps real authorship metadata.
- **Cons:** existing commits don't align with the dependency layers — you'll spend more effort fighting conflicts than authoring. Drop.

### B. Orphan-branch reconstruction (RECOMMENDED)
Start a new orphan branch with no parent, then progressively stage subsets of the current tree and commit each layer.
- **Pros:** total control over the storyline; each commit is exactly what you want; verification per commit is straightforward.
- **Cons:** loses original per-commit authorship metadata (everything will be authored by you, today). Acceptable here because the project is local-only and the original history was already an extraction.

### C. `git replace` overlay
Keep real history intact but provide a "viewable" alternate via `git replace --graft`. Almost no one does this; tooling around it is weak. Skip.

**Recommendation: B (orphan-branch reconstruction).** Concrete plan below.

---

## 5. The script (orphan-branch reconstruction)

### 5.1 Manifest

The driver is a manifest file mapping each commit to its file globs. Place at `scripts/history-rewrite/manifest.json`:

```json
[
  {
    "id": "01",
    "message": "chore: repo skeleton",
    "paths": [
      "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml",
      "tsconfig.json", "turbo.json", "LICENSE", "NOTICE",
      ".gitignore", ".dockerignore"
    ]
  },
  {
    "id": "02",
    "message": "chore(core): util types and helpers",
    "paths": ["packages/core/package.json", "packages/core/tsconfig.json", "packages/core/src/util/**"]
  },
  {
    "id": "03",
    "message": "feat(core/db): SQLite schema + FTS5 setup",
    "paths": ["packages/core/src/db/**"]
  }
  // ... continue per the storyline in section 3
]
```

Glob expansion uses standard shell semantics; the script resolves them against the working tree.

### 5.2 Driver script

`scripts/history-rewrite/run.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_REF="${SOURCE_REF:-main}"           # the messy-history ref to read files from
TARGET_BRANCH="${TARGET_BRANCH:-rewrite}"  # the new clean-history branch
MANIFEST="$REPO_ROOT/scripts/history-rewrite/manifest.json"
VERIFY="${VERIFY:-build}"                  # one of: none, typecheck, build, test

# Safety: refuse to run on a dirty tree
if ! git diff-index --quiet HEAD --; then
  echo "ERROR: working tree dirty. Stash or commit first." >&2
  exit 1
fi

# Snapshot the source tree so we can pull files from it after we've moved off SOURCE_REF
SNAPSHOT_DIR="$(mktemp -d)"
git --work-tree="$SNAPSHOT_DIR" checkout "$SOURCE_REF" -- .
trap 'rm -rf "$SNAPSHOT_DIR"' EXIT

# Start the orphan branch
git checkout --orphan "$TARGET_BRANCH"
git rm -rf --quiet . || true

# Iterate the manifest
node "$REPO_ROOT/scripts/history-rewrite/apply.mjs" \
  --manifest "$MANIFEST" \
  --snapshot "$SNAPSHOT_DIR" \
  --verify "$VERIFY"
```

`scripts/history-rewrite/apply.mjs`:

```javascript
#!/usr/bin/env node
import { readFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { globSync } from 'glob';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
const snapshot = args.snapshot;
const verify = args.verify || 'none';

for (const step of manifest) {
  console.log(`\n=== [${step.id}] ${step.message} ===`);

  // Resolve globs against the snapshot
  const files = step.paths.flatMap(p =>
    globSync(p, { cwd: snapshot, nodir: true, dot: true })
  );

  // Copy each file from snapshot into the working tree
  for (const f of files) {
    const src = join(snapshot, f);
    const dst = join(process.cwd(), f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }

  // Stage and commit
  execSync('git add -A', { stdio: 'inherit' });

  if (verify !== 'none') {
    const cmd = {
      typecheck: 'pnpm -r exec tsc --noEmit',
      build: 'pnpm build',
      test: 'pnpm build && pnpm test'
    }[verify];
    if (!cmd) throw new Error(`unknown verify mode: ${verify}`);
    console.log(`Running verify (${verify}): ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  }

  execSync(`git commit -m ${JSON.stringify(step.message)} --allow-empty`, {
    stdio: 'inherit',
  });
}

console.log('\nDone. Review with: git log --oneline');
```

### 5.3 Workflow

```bash
# 1. Author the manifest carefully (this is the real work)
$EDITOR scripts/history-rewrite/manifest.json

# 2. Dry-run with no verification first to validate the manifest covers every file
VERIFY=none scripts/history-rewrite/run.sh

# 3. Diff the final tree against the source ref — must be IDENTICAL
git diff rewrite main -- .   # expect zero output

# 4. If diff is non-empty, the manifest missed files — add them and re-run

# 5. Re-run with the verification gate of your choice
VERIFY=build scripts/history-rewrite/run.sh

# 6. Inspect the new history
git log --oneline rewrite

# 7. When happy, replace main:
git branch -m main old-main
git branch -m rewrite main
```

---

## 6. Verification gate — pick wisely

The `VERIFY` mode controls how much each commit is validated.

| Mode        | What it runs              | Cost per commit | Use when                            |
|-------------|---------------------------|-----------------|--------------------------------------|
| `none`      | nothing                   | ~0s             | Validating the manifest covers all files |
| `typecheck` | `tsc --noEmit` per pkg    | seconds         | Fast feedback that imports resolve  |
| `build`     | `pnpm build`              | tens of seconds | Default. Each commit must compile.  |
| `test`      | build + `pnpm test`       | minutes         | Maximal rigor; only for the final pass |

**Recommendation:** `typecheck` for iteration, `build` for the final pass.

A subsystem may legitimately fail to typecheck in isolation if it imports a sibling that hasn't been added yet — in that case adjust the manifest order, not the gate.

---

## 7. Edge cases the manifest must handle

These are the snags that will bite if you don't plan for them:

1. **Lockfile.** `pnpm-lock.yaml` lists every package across the workspace. Either commit it whole in step 01, or accept that early commits won't pass `pnpm install`. Whole-in-01 is simpler.

2. **Generated files.** `apps/mcp/dist/`, `apps/web/.next/`, `node_modules/`, `data/*.db*` — these should NOT appear in any commit. Add them to `.gitignore` in step 01 and let it ride.

3. **Cross-cutting test files.** Some test files import from multiple subsystems. Bundle the test commit (step 13/16) AFTER all subsystems it references.

4. **Configs that reference paths.** `turbo.json`, `tsconfig.json` references — make sure the paths they declare exist by the commit they're introduced in.

5. **README screenshots.** `docs/intro.png`, `docs/loop.png`, `docs/screenshot2.png` are referenced from the README. Commit these alongside the README in step 22 (or earlier in a `docs assets` commit if you want).

6. **`.github/workflows/`.** CI files reference `pnpm build` etc. Commit them in step 21 after everything they orchestrate exists.

7. **`glama.json` / version sync.** `scripts/sync-versions.js` and `glama.json` should land with the package.json layer (step 01) since they describe the workspace.

---

## 8. Author and date strategy

The orphan-branch approach makes you the author of every commit, with `now` as the timestamp. That can read as suspicious in a real OSS context, but you've already gone local-only, so it's fine.

If you want backdated timestamps (commits spaced over weeks to look like real development), set them per-commit:

```javascript
const env = {
  ...process.env,
  GIT_AUTHOR_DATE: step.date,
  GIT_COMMITTER_DATE: step.date,
};
execSync(`git commit -m ...`, { stdio: 'inherit', env });
```

Add a `"date": "2024-08-12T10:30:00"` field to each manifest entry. **This is a soft cosmetic choice; do not pretend the rewrite is the actual development timeline.**

---

## 9. Risks and rollback

**Risks:**
- Once you replace `main`, the original history is reachable only via the `old-main` branch (or reflog). Don't delete `old-main` until you're sure.
- If the project is ever republished to GitHub, force-pushing the rewritten history obliterates the public commit graph. Stars/issues survive; commit links in PRs/issues will break.
- Tags pointing at old SHAs (`v9.5.2` etc.) become orphaned. Either retag against the new tip or delete them.

**Rollback:**

```bash
# If old-main still exists locally:
git branch -m main bad-rewrite
git branch -m old-main main

# Or, before deleting old-main, you can also keep both:
git tag pre-rewrite-snapshot old-main
```

**Pre-rewrite checklist:**

- [ ] `git tag pre-rewrite-snapshot HEAD` so you have a named anchor
- [ ] Push `pre-rewrite-snapshot` to a backup remote if you have one (you don't currently — see `git remote -v`)
- [ ] Confirm `data/` and `node_modules/` are in `.gitignore` and not tracked
- [ ] Confirm working tree is clean (`git status`)
- [ ] Run the rewrite with `VERIFY=none` first to validate the manifest
- [ ] Diff `rewrite` vs `main` — must be identical
- [ ] Run with `VERIFY=build` for the real pass
- [ ] Only then swap branch names

---

## 10. What this rewrite will NOT do

- Make the code better. It only reorganizes the *story* of the code. If a subsystem is poorly factored today, it'll still be poorly factored after the rewrite — just introduced cleanly.
- Preserve PR/issue cross-references. SHAs change; old PR comments referencing commits will dangle.
- Recover original authorship. If contributors other than you committed, their identities are lost in the orphan-branch approach.

If any of those matter, switch to strategy A (interactive rebase / `git filter-repo`), accept more conflict pain, and preserve metadata.

---

## 11. Doing it for real — sequence

1. Read this doc end-to-end.
2. `git tag pre-rewrite-snapshot HEAD`
3. Author `scripts/history-rewrite/manifest.json` matching section 3.
4. Implement `scripts/history-rewrite/run.sh` and `apply.mjs` from section 5.2.
5. `VERIFY=none ./scripts/history-rewrite/run.sh` — fix manifest until tree-diff is empty.
6. `VERIFY=build ./scripts/history-rewrite/run.sh` — fix layer ordering until every commit builds.
7. `git branch -m main old-main && git branch -m rewrite main`
8. Live with it for a week before deleting `old-main`.
