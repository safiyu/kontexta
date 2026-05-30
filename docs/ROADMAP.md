# Roadmap

Tracked work that's known but deliberately deferred. Each item lists what and why it was deferred. Items are pulled forward to a real implementation plan when they earn their place.

Status legend: 🟢 open · 🟡 in-progress · ⚪ snoozed (revisit when evidence demands it)

---

## Brain — Journaling

### 🟢 Per-call project resolution

**The gap.** Today the journal capture wrapper writes every event under one project slug, set once at MCP bootstrap from `KONTEXTA_DEFAULT_PROJECT_SLUG`. Tools that touch other projects (path-based reads, cross-project `search`, admin tools like `register_project`) end up logged under the wrong slug. For users who work in one project per agent session this is invisible; for multi-project workflows it breaks the per-project journal queries the design intends.

**Recommended approach: Hybrid (heuristic + opt-in override).** Wrapper resolves the project per call from `args.file_id` or `args.path` (with a small LRU cache invalidated on `register_project`/`unregister_project`). Tools that genuinely cross projects (search, list_projects, register_project) opt out by returning a `_journal: { project_slug: "__cross__" | "__admin__" }` field that the wrapper strips before responding. ~3 tools need touching; the other ~50 just work.

**Implementation outline:**
- Resolver utility: `path/file_id → slug` with LRU + invalidation hooks
- `MultiProjectJournalWriter` — lazy fd per slug, close-all on shutdown
- `wrapHandler` integration: route per call, strip `_journal` from result
- Opt-in overrides on the 3 cross-project tools
- Tests: multi-project fixture with assertions per project's raw dir

**Trigger to pull forward:** when anyone runs kontexta against more than one project in the same MCP session.

---

### ⚪ Server-side LLM upgrade (deferred from Phase 2)

**The gap.** The WebUI scheduler runs mechanical distillation on a clock, but never upgrades to LLM-narrative on its own — that requires an agent to call `distill_journal` and dispatch subagents. So if no agent is connected for a week, mechanical entries pile up without polish.

**Why deferred.** Mechanical mode produces ~60% quality at $0; the agent-driven LLM upgrade path covers the remaining 40% on demand. Adding server-side LLM means kontexta starts holding API keys + a daily cost-cap state machine + UTC reset logic + per-project budgets. Real architectural shift, not worth shipping until users ask.

**Trigger to pull forward:** real complaint that scheduled mechanical entries aren't enough, AND a user willing to provide an `ANTHROPIC_API_KEY`.

---

### ⚪ Layer 3 — Embeddings + graph + semantic clustering

**The gap.** Retrieval today is FTS5 + tags + per-project filters + git-ref joins. Works well for "every entry that touched X.ts" or "all decisions tagged abandoned." Doesn't work for "entries semantically similar to this one I'm reading right now" or "incident chain across these 5 outages."

**Why deferred.** No vector DB until evidence shows FTS+tags is the bottleneck. Vector indexes add a dependency, a model choice, and a re-embed-on-content-change cost. Ship it when someone has a query they cannot answer with the current surface.

**Trigger to pull forward:** real query the user wants that the existing primitives can't satisfy.

---

### 🟢 One-shot CLI for `distill_journal`

**The gap.** The SessionStart hook snippet that `onboard_agent` surfaces today is informational only:
```json
{ "type": "command", "command": "echo 'kontexta: distill_journal recommended at session start' && true" }
```
Because there's no way to invoke a single MCP tool from the shell. If the kontexta-mcp CLI accepted `--tool distill_journal --json '{}'`, the snippet becomes a working hook.

The trickier bit is initializing the journal capture singleton + DB without a transport.

**Trigger to pull forward:** when someone wires up a real Stop/SessionStart hook and notices the placeholder.

---

### 🟢 Subagent prompt template for LLM-upgrade flow

**The gap.** Phase 2's `distill_journal_commit_upgrades` tool exists, but the actual subagent prompt template that takes raw events → polished narrative isn't written yet. Today an agent calling `distill_journal` gets back the events and is expected to construct its own subagent prompt.

Iterate the prompt template against real raw-event samples from a few representative tasks, then ship it as a returned field from `distill_journal` so the calling agent can dispatch it verbatim.

**Trigger to pull forward:** first user who actually runs the LLM-upgrade flow at scale.

---

## Hands — Sandboxed commands

_(no open items; system has been stable since the 7.x line)_

---

## Web — Dashboard

### 🟢 Proper vitest setup in `apps/web`

**The gap.** Phase 2 web tests (panel, scheduler, scheduler-e2e, byte-identity) currently use a compile-to-tmp workaround: `tsc → /tmp → node --test --import` against the compiled output. Works, but fragile; tests can break if the on-the-fly compile flags drift from Next.js's actual config.

Add vitest config with the right Next.js mocks + jsdom env; rewrite the four mjs tests as `.test.ts` files; replace the tsc shim with a normal vitest test command; wire `pnpm --filter kxta-web test` to call vitest.

**Trigger to pull forward:** when a Phase 3 web feature needs more than smoke tests.

---

### 🟢 WebUI scheduler intervals from `kontexta.json`

**The gap.** The Settings → Journal panel exposes `mechanical_distill_interval_minutes` and `housekeep_interval_hours` as form fields, but the running `JournalScheduler` reads its intervals from constructor opts (defaulting to 15min / 24h) and ignores the per-project config. Changing the form values writes to `kontexta.json` but doesn't actually change the schedule until the WebUI restarts.

Scheduler should read project config on each tick (cheap — one JSON file read per project per 15min) and skip the mechanical pass when `webui_scheduler.enabled` is false.

**Trigger to pull forward:** when someone sets the form value, sees no effect, files a bug.

---

## Cleanup / debt

### 🟢 `MNEXIS_DATA_DIR` test failures

7 MCP tests fail because the test harness still references `MNEXIS_DATA_DIR` instead of `KONTEXTA_DATA_DIR` (leftover from the rename). They're pre-existing and unrelated to journaling, but they're noise.

### 🟢 Cold-task auto-reactivation

`housekeep_journal` archives a task when `last_active_at > 365 days ago`. If new events match an archived topic, the design says it should reactivate automatically — currently a new task with a `-revisited` suffix is minted instead. Topic detection needs to look in `_archive/` and pull the file back when matched.

---

## Process notes

- Items are added when discussed, even if not committed work. Keeps the "deferred but real" stuff visible.
- An item gets pulled forward when there's a concrete trigger (user demand, blocking dependency, or readiness signal). Until then it sits here.
- ⚪ items might never ship — that's fine. The point is to avoid re-discovering them.
- Each shipped item gets removed from this file and lives in `CHANGELOG.md` instead.
