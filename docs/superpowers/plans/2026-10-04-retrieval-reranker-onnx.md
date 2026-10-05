# Local System 1 Decision & Retrieval Architecture Implementation Plan
## Candidate Reranking, Search Verdicts, and Journal Distillation

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Kontexta's retrieval and distillation subsystems from rigid heuristics (SQL `ORDER BY content_class = 'dictionary'`, regex ticket detectors, word-slug topic splitters) into an adaptive, zero-external-API **System 1 Neural Decision Architecture**:
1. **Tier 1 — Fast Pairwise Reranker ($O(K)$):** Sub-30ms CPU cross-encoder scoring (`Xenova/ms-marco-MiniLM-L-6-v2` or `bge-reranker-small`) combined with Bayesian soft priors for content-class arbitration without hard SQL sorting traps.
2. **Tier 2 — Non-Autoregressive Decision Engine ($O(1)$):** Multi-head calibrated decision model (Laya / ModernBERT architecture) providing zero-temperature structured verdicts across search and background distillation:
   - **File Search Verdicts:** Pre-retrieval query intent routing (`choice`), post-retrieval context sufficiency & halting check (`noul`), and low-relevance hallucination pruning (`score 0-4`).
   - **Journal Distillation Intelligence:** Raw event signal vs. noise triage (`score 0-4`), semantic task boundary & topic pivot detection (`noul`/`choice`), and deterministic task archetype labeling (`choice`).
3. **Unified Local Inference Substrate:** Shared ONNX runtime manager in `packages/core/src/inference/` supporting process safety, memory limits, and 100% graceful fallback to legacy heuristics.

**Tech Stack:** TypeScript (ESM, Node.js ≥ 20/22), `@huggingface/transformers` (v4.3+), ONNX Runtime, SQLite FTS5 (better-sqlite3), Vitest.

---

## 1. Architectural Foundations: Dual-Tier Local Model Topology

Context retrieval and event distillation have fundamentally different algorithmic complexity and latency requirements. Evaluating a single model across all tasks creates a dilemma: a 421M-parameter decision model is too heavy for $O(K)$ candidate reranking on CPU, while a 33M cross-encoder cannot perform multi-class categorical decisions or binary sufficiency verdicts.

We resolve this through a **two-tier local model topology**:

```
                                  Incoming Request / Event Stream
                                                 │
                   ┌─────────────────────────────┴─────────────────────────────┐
                   ▼                                                           ▼
     [Interactive Search Pipeline]                               [Background Journal Pipeline]
     (files_search, bundleSearch)                                (distillJournal, Topic Detection)
     Interactive Budget: < 180ms total CPU                       Cooldown Budget: 500ms - 2s CPU
                   │                                                           │
   ┌───────────────┴───────────────┐                           ┌───────────────┴───────────────┐
   │                               │                           │                               │
   ▼                               ▼                           ▼                               ▼
[O(1) Search Verdicts]   [O(K) Candidate Rerank]     [O(1) Event Triage]      [O(1) Boundary & Pivot]
Decision Engine          Fast Cross-Encoder          Decision Engine          Decision Engine
• Query Intent Router    • 30-50 doc pairwise rank   • Signal/noise (0-4)     • Context shift (noul)
• Sufficiency Check      • Soft Bayesian prior       • Filter shell fluff     • Task archetype label
• Relevance floor        • 23MB int8, <30ms CPU      • Background batch       • Grouping replacement
```

### Architectural Comparison Matrix

| Capability | Fast Pairwise Reranker (Tier 1) | Multi-Head Decision Engine (Tier 2) | Legacy Heuristics (Status Quo) |
| :--- | :--- | :--- | :--- |
| **Model Archetype** | Cross-Encoder (`ms-marco-MiniLM-L-6-v2`) | ModernBERT Multi-Head (`Laya` architecture) | Better-SQLite3 FTS5 + Regexes |
| **Model Size (int8)** | **~23MB disk / ~80MB RSS** | **~120-220MB disk / ~350MB RSS** | 0 MB (Code only) |
| **Inference Mode** | Pairwise Sequence Classification | Multi-Task Classification (`choice`, `noul`, `score`) | Deterministic Rule Engine |
| **Algorithmic Cost** | **$O(K)$** ($K = 30\text{--}50$ candidates) | **$O(1)$** (1 forward pass per query/task) | $O(N)$ regex passes |
| **CPU Latency** | **~0.98ms / pair** (29ms for 30 docs) | **~110–160ms single pass** on CPU | < 2ms |
| **Primary Domain** | Candidate scoring & doc ordering | Search verdicts & journal distillation | Brittle fallback |
| **Failure Safety** | Immediate fallback to BM25 rank | Fallback to regex & mechanical heuristics | N/A |

---

## 2. Detailed Technical Design by Subsystem

### Subsystem A: Real-Time Candidate Reranking & Content Arbitration ($O(K)$)

In Kontexta's current codebase ([`metadata/index.ts`](file:///home/safiyu/Projects/kontexta/packages/core/src/metadata/index.ts#L186-L191) and [`bundle/index.ts`](file:///home/safiyu/Projects/kontexta/packages/core/src/bundle/index.ts#L115-L158)), search enforces a hard SQL sort:
```sql
ORDER BY (files.content_class = 'dictionary') DESC, rank, files.id LIMIT 50
```
This causes the **"Dictionary Trap"**: generic glossaries or runbooks consistently crowd out specific incident notes, debug traces, and post-mortems because `dictionary` always wins unconditionally.

#### Solution: Two-Stage Retrieval with Soft Bayesian Arbitration
1. **Stage 1 (Unbiased Candidate Generation):** SQLite FTS5 retrieves top $K = 30\text{--}50$ candidates using raw BM25 rank (`raw_bm25_order: true`), stripping the hard SQL content-class sort.
2. **Stage 2 (Cross-Encoder Neural Scoring):** Run candidate pairs $(Query, Passage_i)$ through `ms-marco-MiniLM-L-6-v2` ONNX int8 runtime. Passages are truncated to title + first 256 tokens / 1000 characters.
3. **Stage 3 (Soft Bayesian Prior Fusion):**
   $$Score_{\text{final}} = \sigma(\text{logit}) + \beta(content\_class)$$
   Where:
   - $\sigma(R) = \frac{1}{1 + e^{-R}} \in [0, 1]$
   - $\beta(\text{'dictionary'}) = +0.08$ (configurable authority tiebreaker)
   - $\beta(\text{'note'}) = 0.00$
   - $\beta(\text{'journal'}) = -0.02$
   - $\beta(\text{'project'}) = 0.00$
4. **Behavioral Outcome:**
   - If an incident note has specific semantic relevance ($R = 0.95$) and a dictionary runbook is only generic ($R = 0.45$), the note wins ($0.95 > 0.53$).
   - If both are equally relevant ($R_{\text{dict}} = 0.86, R_{\text{note}} = 0.88$), dictionary wins tiebreak ($0.86 + 0.08 = 0.94 > 0.88$).

---

### Subsystem B: File Search Verdicts & Context Guardrails ($O(1)$)

Candidate reranking sorts documents, but it cannot evaluate query intent, filter out low-confidence hallucinations, or determine whether retrieved context is sufficient. The **Decision Engine** runs two $O(1)$ passes around search:

```
                            User Query: "how to clean up orphaned background tasks"
                                                       │
                                                       ▼
                                     ┌───────────────────────────────────┐
                                     │ Step 1: Query Intent Router       │ (Decision Engine: choice head)
                                     │ Pass 1: O(1) forward pass (~120ms)│
                                     │ Result: intent = "ops_runbook"    │
                                     │ Prior: beta(dict) = +0.12         │
                                     └─────────────────┬─────────────────┘
                                                       │
                                                       ▼
                                     ┌───────────────────────────────────┐
                                     │ Step 2: FTS5 Candidate Retrieval  │
                                     │ BM25 Top 30 Candidates            │
                                     └─────────────────┬─────────────────┘
                                                       │
                                                       ▼
                                     ┌───────────────────────────────────┐
                                     │ Step 3: Fast Neural Reranking     │ (Cross-Encoder: 30 pairs)
                                     │ Pass 2: O(K) cross-attn (<30ms)   │
                                     │ Sigmoid + Soft Prior Fusion       │
                                     └─────────────────┬─────────────────┘
                                                       │
                                                       ▼
                                     ┌───────────────────────────────────┐
                                     │ Step 4: Relevance Pruning Floor   │ (Confidence Cutoff)
                                     │ Filter docs where score < 0.15    │
                                     └─────────────────┬─────────────────┘
                                                       │
                                                       ▼
                                     ┌───────────────────────────────────┐
                                     │ Step 5: Sufficiency Verdict       │ (Decision Engine: noul head)
                                     │ Pass 3: Top-3 vs Query (~120ms)   │
                                     │ Result: satisfied = true (0.92)   │
                                     └─────────────────┬─────────────────┘
                                                       │
                                                       ▼
                                              Greedy Token Packing
```

1. **Pre-Retrieval Query Intent Routing (`choice` head):**
   - Classifies query into one of:
     - `spec_authoritative`: User wants official schema, architecture, or rule definition $\to$ boost dictionary prior $\beta = +0.15$.
     - `troubleshooting_incident`: User is debugging an active error or failure $\to$ zero/negative dictionary boost $\beta = -0.05$ to favor raw incident notes.
     - `code_symbol`: Query targets an exact function, variable, or class identifier $\to$ trigger regex hybrid search fallback if FTS tokenization fails.
     - `general_exploration`: Standard hybrid weights ($\beta = +0.08$).
2. **Relevance Pruning & Floor Filtering:**
   - Any candidate document with normalized score $< 0.15$ (raw logit $< -4.0$) is excluded from bundle packing, preventing low-relevance padding from exhausting agent prompt tokens.
3. **Retrieval Sufficiency & Halting Verdict (`noul` head):**
   - After ranking, top-3 document summaries are concatenated with the query and evaluated:
     `Query: <q> | Excerpts: <e1, e2, e3> | Verdict: Does this context adequately answer the user request?`
   - Emits structured verdict `{ satisfied: boolean, confidence: number, reasoning_category: string }`.
   - When `satisfied === false` in `bundleSearch`, the response metadata flags `sufficiency_warning: true` so agent callers know to broaden search terms rather than hallucinating over irrelevant text.

---

### Subsystem C: Journal Distillation Semantic Intelligence ($O(1)$ Batch)

In [`packages/core/src/journal/distill.ts`](file:///home/safiyu/Projects/kontexta/packages/core/src/journal/distill.ts) and [`packages/core/src/journal/topic-detector.ts`](file:///home/safiyu/Projects/kontexta/packages/core/src/journal/topic-detector.ts), the engine processes background raw event logs using mechanical regexes:
- Labeling relies on `labelFor`: taking the first 6 words of a prompt or agent name.
- Grouping relies on `intersect(touched_files)` and branch names.
- Event filtering relies on static regexes, meaning high-volume shell commands (`ls`, `git status`, failed builds) clutter the distilled markdown logs.

Distillation runs **in the background on a 60-second cooldown lock**, providing a relaxed inference budget of **500ms to 2 seconds**. The Decision Engine provides three semantic capabilities:

```
         Raw Events Stream (Shell hooks, agent notes, user prompts, git context)
                                           │
                                           ▼
             ┌───────────────────────────────────────────────────────────┐
             │ 1. Event Signal vs. Noise Triage (score 0-4 head)         │
             │ Grade every incoming event from 0 (noise) to 4 (critical) │
             │ Suppress grade 0 (e.g. repeated ls, git status) from KB   │
             └─────────────────────────────┬─────────────────────────────┘
                                           │ (High-signal events only)
                                           ▼
             ┌───────────────────────────────────────────────────────────┐
             │ 2. Semantic Task Boundary & Pivot Detector (noul head)    │
             │ Evaluates: Is this prompt a topic shift from active task? │
             │ Replaces blind session affinity & arbitrary 6-word slugs  │
             └─────────────────────────────┬─────────────────────────────┘
                                           │
                                           ▼
             ┌───────────────────────────────────────────────────────────┐
             │ 3. Deterministic Task Archetype Labeling (choice head)    │
             │ Maps task clusters to [debug, refactor, infra, feature]   │
             │ Injects clean frontmatter metadata without LLM cost       │
             └─────────────────────────────┬─────────────────────────────┘
                                           │
                                           ▼
                       Render & Index to Markdown Knowledge Base
```

1. **Event Signal vs. Noise Triage (`score 0-4` head):**
   - **Grade 0 (Noise):** Repetitive status checks (`git status`, `ls`, empty commands). Dropped from distilled markdown entries (preserved only in raw JSONL).
   - **Grade 1 (Routine):** Minor file edits, successful dependency checks.
   - **Grade 2 (Context Shift):** Branch change, environment variable update, new dependency.
   - **Grade 3 (High Signal):** Test failures, error stack traces, incident notes.
   - **Grade 4 (Critical Pivot):** Architectural decisions, abandonments (`journal_write({ kind: "note" })`), major refactors.
2. **Semantic Task Boundary & Topic Pivot Detection (`noul` head):**
   - When an agent is working in a long session, mechanical grouping defaults to session affinity, merging unrelated debugging tasks into one task file.
   - When a new prompt or intent arrives, the Decision Engine evaluates:
     `Active Task Context: <title + recent files> | Incoming Event: <prompt/note> | Question: Is this a distinct task pivot?`
   - If `noul: true`, it cleanly mints a new task bucket rather than appending to the previous thread.
3. **Deterministic Task Archetype Labeling (`choice` head):**
   - Classifies task buckets into standardized tags:
     `['debugging', 'refactoring', 'infra_ops', 'feature_dev', 'research_exploration', 'documentation']`.
   - Replaces random title slugs with structured, queryable categories in frontmatter.

---

## 3. Global Constraints & Non-Negotiable Requirements

1. **100% Local & Zero External APIs:** No OpenAI, Anthropic, or Cohere API keys required. All inference runs locally in Node.js via ONNX runtime bindings or WASM fallback.
2. **Strict Process & Thread Safety:** Model execution must never lock the Node.js event loop. Batches must be processed with micro-yields (`setImmediate`) or worker threads if batch size $> 50$.
3. **Graceful Zero-Crash Degradation:**
   - If model weights are missing or downloading: fallback immediately to BM25 and regex heuristics.
   - If inference exceeds timeout: hard `Promise.race` aborts inference and falls back immediately.
4. **Target Performance Budgets:**
   - Reranker Single Pair: $\le 1.5\text{ms}$ on CPU.
   - Reranker Batch of 30: $\le 35\text{ms}$ on CPU (validated in spike: $29.26\text{ms}$).
   - Decision Engine Single Pass ($O(1)$ search verdict): $\le 150\text{ms}$ on CPU.
   - Search Hard Timeout: $300\text{ms}$.
   - Distillation Batch Budget: $\le 2000\text{ms}$ in background.
5. **Memory Footprint Budget:**
   - Total model weights disk usage: $\le 250\text{MB}$ combined.
   - Process RSS overhead: $\le 350\text{MB}$ peak.

---

## 4. Phase-by-Phase Implementation Tasks

```
Phase 1: Shared Inference Foundation & Spikes
   │
   ├─► Task 1: Shared Inference Runtime & Model Cache (packages/core/src/inference/)
   ├─► Task 2: Cross-Encoder Spike & Benchmark (scripts/spikes/onnx-rerank-spike.mjs) [DONE]
   └─► Task 3: Decision Model Multi-Head Spike (scripts/spikes/onnx-decision-spike.mjs)
   │
Phase 2: High-Speed Candidate Reranking Pipeline
   │
   ├─► Task 4: Core ONNX Cross-Encoder Engine (packages/core/src/rerank/engine.ts)
   ├─► Task 5: Soft Content-Class Arbitrator (packages/core/src/rerank/arbitrator.ts)
   ├─► Task 6: Candidate Retrieval Integration (packages/core/src/metadata/index.ts)
   └─► Task 7: bundleSearch Two-Stage Integration (packages/core/src/bundle/index.ts)
   │
Phase 3: File Search Verdicts & Guardrails (Decision Engine)
   │
   ├─► Task 8: Structured Decision Engine Client (packages/core/src/decision/engine.ts)
   ├─► Task 9: Pre-Retrieval Query Intent Router (packages/core/src/decision/intent-router.ts)
   ├─► Task 10: Retrieval Sufficiency Evaluator (packages/core/src/decision/sufficiency.ts)
   └─► Task 11: Candidate Relevance Pruning & Floor Filter (packages/core/src/decision/pruning.ts)
   │
Phase 4: Journal Distillation Semantic Intelligence
   │
   ├─► Task 12: Event Signal/Noise Triage Filter (packages/core/src/journal/event-triage.ts)
   ├─► Task 13: Semantic Task Boundary & Topic Pivot Detector (packages/core/src/journal/topic-detector.ts)
   └─► Task 14: Deterministic Task Categorization & Archetypes (packages/core/src/journal/distill.ts)
   │
Phase 5: MCP Tool Surface, Configuration & End-to-End Validation
   │
   ├─► Task 15: MCP Tool Surface & kontexta.json Config Wireup (apps/mcp/src/index.ts)
   └─► Task 16: Comprehensive Test Suite, Retrieval Benchmarks & Spec Docs
```

---

### Phase 1: Shared Inference Foundation & Spikes

#### Task 1: Shared Inference Runtime & Model Cache Manager (`packages/core/src/inference/`)
**Goal:** Create a robust, shared local inference substrate that manages model weight caching, hardware acceleration detection (CPU AVX2/NEON vs GPU), and thread-safe singleton model lifecycles for both Tier 1 (reranker) and Tier 2 (decision model).

**Files:**
- Create: `packages/core/src/inference/types.ts`
- Create: `packages/core/src/inference/cache-manager.ts`
- Create: `packages/core/src/inference/runtime.ts`
- Create: `packages/core/src/inference/index.ts`
- Test: `packages/core/tests/inference-cache.test.ts`

**Interfaces:**
```ts
// packages/core/src/inference/types.ts
export type ExecutionDevice = "cpu" | "gpu" | "auto" | "wasm";

export interface ModelRuntimeConfig {
  modelId: string;
  subfolder?: string;
  quantized?: boolean;
  device?: ExecutionDevice;
  timeoutMs?: number;
  cacheDir?: string;
}

export interface ModelSessionStatus {
  modelId: string;
  loaded: boolean;
  device: string;
  memoryRssBytes: number;
  loadDurationMs: number;
}
```

- [ ] **Step 1: Define inference types** in `packages/core/src/inference/types.ts`.
- [ ] **Step 2: Implement model cache manager** in `packages/core/src/inference/cache-manager.ts`:
  - Priority order: `$KONTEXTA_MODEL_CACHE` $\to$ `<dataDir>/models` $\to$ `~/.cache/kontexta/models`.
  - Checks file integrity and existence before attempting online downloads.
  - Exposes `isModelCachedLocally(modelId: string): boolean`.
- [ ] **Step 3: Implement `InferenceRuntime` singleton** in `packages/core/src/inference/runtime.ts`:
  - Initializes `@huggingface/transformers` environment variables (`env.allowRemoteModels`, `env.cacheDir`).
  - Implements device selection (`cpu` vs `cuda`/`directml` with automatic fallback).
  - Handles process teardown cleanup via `beforeExit` hooks.
- [ ] **Step 4: Export module** in `packages/core/src/inference/index.ts`.
- [ ] **Step 5: Write unit tests** in `packages/core/tests/inference-cache.test.ts` verifying path resolution, offline checks, and singleton isolation.
- [ ] **Step 6: Run test suite**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/inference-cache.test.ts
  ```

---

#### Task 2: Cross-Encoder Spike & Performance Benchmark
**Status:** **COMPLETED & VERIFIED**
- Script: `scripts/spikes/onnx-rerank-spike.mjs`
- Spec: `docs/superpowers/specs/2026-10-04-onnx-reranker-benchmark.md`
- Results: 30 candidates scored in **29.26ms** on CPU (~0.98ms/pair). Model size: 23MB int8. Note discrimination: 0.9998 vs 0.0003.

---

#### Task 3: Decision Model Multi-Head Spike & Benchmark
**Goal:** Create a standalone spike script to validate non-autoregressive multi-head classification (`choice`, `score 0-4`, `noul`) using a quantized ModernBERT/BERT decision backbone on CPU, benchmarking latency, calibration, and memory.

**Files:**
- Create: `scripts/spikes/onnx-decision-spike.mjs`
- Test: `node scripts/spikes/onnx-decision-spike.mjs`

- [ ] **Step 1: Write `scripts/spikes/onnx-decision-spike.mjs`**:
  - Test three distinct tasks in one forward pass:
    1. Query Intent Routing: classify query into 4 archetypes (`spec`, `incident`, `symbol`, `general`).
    2. Retrieval Sufficiency: evaluate query + 3 passage snippets for yes/no resolution (`noul`).
    3. Event Signal Grading: score 5 sample log events (e.g. `git status` vs `TypeError: null pointer`) from 0 to 4.
  - Measure single-pass CPU execution latency ($< 150\text{ms}$ budget).
- [ ] **Step 2: Run benchmark script**:
  ```bash
  node scripts/spikes/onnx-decision-spike.mjs
  ```
- [ ] **Step 3: Document benchmark metrics** in `docs/superpowers/specs/2026-10-04-onnx-reranker-benchmark.md`.

---

### Phase 2: High-Speed Candidate Reranking Pipeline

#### Task 4: Core ONNX Cross-Encoder Engine (`packages/core/src/rerank/engine.ts`)
**Goal:** Build the production-grade ONNX reranker client inside `packages/core/src/rerank/` with singleton lazy loading, passage truncation, batching, and timeout fallback.

**Files:**
- Modify: `packages/core/src/rerank/types.ts`
- Create: `packages/core/src/rerank/engine.ts`
- Create: `packages/core/src/rerank/index.ts`
- Test: `packages/core/tests/rerank-engine.test.ts`

- [ ] **Step 1: Finalize candidate types** in `packages/core/src/rerank/types.ts` (already scaffolded).
- [ ] **Step 2: Implement `RerankEngine` class** in `packages/core/src/rerank/engine.ts`:
  - Lazy asynchronous singleton initialization.
  - Truncation helper: truncates passage text to first 1,000 characters / 256 tokens.
  - Safe execution wrapper with `Promise.race` for `timeout_ms` (default 300ms).
  - Returns `null` on error or timeout to trigger seamless fallback.
- [ ] **Step 3: Write unit tests** in `packages/core/tests/rerank-engine.test.ts`:
  - Test cold start, warm latency, sigmoid bound verification ($0 \le \sigma \le 1$), and timeout resilience.
- [ ] **Step 4: Run engine tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/rerank-engine.test.ts
  ```

---

#### Task 5: Soft Content-Class Arbitrator (`packages/core/src/rerank/arbitrator.ts`)
**Goal:** Implement Bayesian arbitration logic balancing cross-encoder semantic relevance against content-class authority (`dictionary` vs `note`), eliminating hard SQL sorting traps.

**Files:**
- Create: `packages/core/src/rerank/arbitrator.ts`
- Test: `packages/core/tests/arbitrator.test.ts`

- [ ] **Step 1: Implement `arbitrateCandidates(candidates, opts)`** in `packages/core/src/rerank/arbitrator.ts`:
  - Normalized score: $\sigma(R) = \frac{1}{1 + e^{-R}}$.
  - Additive class prior: $\beta(\text{'dictionary'}) = +0.08, \beta(\text{'note'}) = 0.0, \beta(\text{'journal'}) = -0.02$.
  - Computes `final_score` and sorts descending.
- [ ] **Step 2: Write test cases in `packages/core/tests/arbitrator.test.ts`**:
  - Test 1: High-relevance note beats lower-relevance dictionary doc ($0.95 > 0.45 + 0.08$).
  - Test 2: Close relevance tiebreaker favors dictionary doc ($0.86 + 0.08 = 0.94 > 0.88$).
  - Test 3: Null/custom class handling and custom `dictionary_boost` override.
- [ ] **Step 3: Run arbitrator tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/arbitrator.test.ts
  ```

---

#### Task 6: Candidate Retrieval Integration (`packages/core/src/metadata/index.ts`)
**Goal:** Modify `search()` in `packages/core/src/metadata/index.ts` to support fetching an unbiased candidate pool for the neural reranker (`raw_bm25_order: true`), bypassing the rigid SQL `ORDER BY (content_class = 'dictionary') DESC`.

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/metadata/index.ts`
- Test: `packages/core/tests/metadata.test.ts`
- Test: `packages/core/tests/search-content-class.test.ts`

- [ ] **Step 1: Extend `SearchFilters` in `packages/core/src/types.ts`**:
  ```ts
  export interface SearchFilters {
    query: string;
    project_id?: number | null;
    tags?: string[];
    favorite?: boolean;
    content_class?: ContentClass | null;
    limit?: number;
    raw_bm25_order?: boolean;
  }
  ```
- [ ] **Step 2: Update SQL generator in `packages/core/src/metadata/index.ts`**:
  - If `filters.raw_bm25_order === true`, emit `ORDER BY rank, files.id LIMIT ${limit}`.
  - Otherwise retain legacy dictionary-first ordering for backwards compatibility.
- [ ] **Step 3: Run regression tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/search-content-class.test.ts
  ```

---

#### Task 7: `bundleSearch` Two-Stage Retrieval Integration (`packages/core/src/bundle/index.ts`)
**Goal:** Wire the neural reranker and arbitrator into [`bundleSearch`](file:///home/safiyu/Projects/kontexta/packages/core/src/bundle/index.ts#L105) so that context bundles contain semantically optimal files within the token budget.

**Files:**
- Modify: `packages/core/src/bundle/index.ts`
- Test: `packages/core/tests/bundle.test.ts`
- Create: `packages/core/tests/bundle-rerank.test.ts`

- [ ] **Step 1: Extend `BundleOptions` and `BundleResult`**:
  - Add `rerank?: boolean`, `candidate_limit?: number`, `dictionary_boost?: number`.
  - Annotate `included` and `skipped` items with `rerank_score?: number` and `final_score?: number`.
- [ ] **Step 2: Update `bundleSearch` execution flow**:
  - Fetch candidate pool ($K = \max(\text{limit}, 30)$) with `raw_bm25_order: true`.
  - Execute `rerankCandidates(query, candidates, opts)`.
  - Fall back gracefully to BM25 order if reranker fails or returns `null`.
  - Greedily pack files up to `max_tokens`.
- [ ] **Step 3: Write tests in `packages/core/tests/bundle-rerank.test.ts`**:
  - Verify that a relevant note is packed ahead of a less relevant dictionary entry.
  - Verify that when `rerank: false`, legacy BM25/SQL order is preserved.
- [ ] **Step 4: Run bundle test suite**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/bundle-rerank.test.ts
  ```

---

### Phase 3: File Search Verdicts & Guardrails (Decision Engine)

#### Task 8: Structured Decision Engine Client (`packages/core/src/decision/engine.ts`)
**Goal:** Build the core `DecisionEngine` wrapper providing structured, zero-temperature classification heads (`choice`, `noul`, `score`) using the shared inference runtime.

**Files:**
- Create: `packages/core/src/decision/types.ts`
- Create: `packages/core/src/decision/engine.ts`
- Create: `packages/core/src/decision/index.ts`
- Test: `packages/core/tests/decision-engine.test.ts`

**Interfaces:**
```ts
// packages/core/src/decision/types.ts
export interface ChoiceDecision<T extends string = string> {
  selected: T;
  confidence: number;
  distribution: Record<T, number>;
}

export interface BinaryVerdict {
  verdict: boolean;
  confidence: number;
  logit: number;
}

export interface ScoreRating {
  score: number;      // 0 to 4
  calibrated: number; // Continuous score 0.0 - 4.0
}
```

- [ ] **Step 1: Define types** in `packages/core/src/decision/types.ts`.
- [ ] **Step 2: Implement `DecisionEngine` class** in `packages/core/src/decision/engine.ts`:
  - `classifyChoice<T>(context: string, options: T[]): Promise<ChoiceDecision<T>>`
  - `evaluateVerdict(context: string, question: string): Promise<BinaryVerdict>`
  - `rateScore(context: string, criteria: string): Promise<ScoreRating>`
  - Timeout and error protection returning deterministic fallback values.
- [ ] **Step 3: Write unit tests** in `packages/core/tests/decision-engine.test.ts`.
- [ ] **Step 4: Run decision engine tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/decision-engine.test.ts
  ```

---

#### Task 9: Pre-Retrieval Query Intent Router (`packages/core/src/decision/intent-router.ts`)
**Goal:** Implement intent classification over user search queries to dynamically adjust candidate generation limits, content-class priors, and search fallback strategies.

**Files:**
- Create: `packages/core/src/decision/intent-router.ts`
- Test: `packages/core/tests/intent-router.test.ts`

- [ ] **Step 1: Implement `routeQueryIntent(query: string)`**:
  - Maps query to:
    - `"spec_authoritative"` $\to$ Boost dictionary prior to $+0.15$.
    - `"troubleshooting_incident"` $\to$ Set dictionary prior to $-0.05$ (favor notes/incidents).
    - `"code_symbol"` $\to$ Flag potential regex search fallback if BM25 recall is 0.
    - `"general_exploration"` $\to$ Standard priors.
- [ ] **Step 2: Write test cases in `packages/core/tests/intent-router.test.ts`**:
  - Test intent classification on sample queries.
  - Test heuristic fallback when model is uninitialized.
- [ ] **Step 3: Run router tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/intent-router.test.ts
  ```

---

#### Task 10: Retrieval Sufficiency Evaluator (`packages/core/src/decision/sufficiency.ts`)
**Goal:** Evaluate whether the top retrieved documents actually answer the user's query or merely contain keyword overlap, preventing low-relevance hallucination.

**Files:**
- Create: `packages/core/src/decision/sufficiency.ts`
- Test: `packages/core/tests/sufficiency.test.ts`

- [ ] **Step 1: Implement `evaluateSufficiency(query: string, candidateExcerpts: string[])`**:
  - Concatenates query with top-3 candidate titles/snippets.
  - Queries `DecisionEngine.evaluateVerdict` with `"Does this retrieved context adequately address the query?"`.
  - Returns `{ satisfied: boolean, confidence: number }`.
- [ ] **Step 2: Wire into `bundleSearch`**:
  - Adds `sufficiency` field to `BundleResult.meta`.
  - If `satisfied === false`, sets `meta.warning = "Context may be insufficient or tangential"`.
- [ ] **Step 3: Write tests in `packages/core/tests/sufficiency.test.ts`**.
- [ ] **Step 4: Run sufficiency tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/sufficiency.test.ts
  ```

---

#### Task 11: Candidate Relevance Pruning & Floor Filtering (`packages/core/src/decision/pruning.ts`)
**Goal:** Prune candidate documents that fall below a calibrated relevance floor ($\sigma < 0.15$ / logit $< -4.0$) so that prompt budgets are never wasted on tangential documents just because tokens remain.

**Files:**
- Create: `packages/core/src/decision/pruning.ts`
- Modify: `packages/core/src/bundle/index.ts`
- Test: `packages/core/tests/pruning.test.ts`

- [ ] **Step 1: Implement `pruneLowRelevanceCandidates(candidates, floorScore = 0.15)`**.
- [ ] **Step 2: Integrate into `bundleSearch`**:
  - Candidates below `floorScore` are added to `skipped` with reason `"below_relevance_threshold"`.
- [ ] **Step 3: Write tests** verifying that irrelevant files are pruned even when `max_tokens` is far from exhausted.
- [ ] **Step 4: Run pruning tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/pruning.test.ts
  ```

---

### Phase 4: Journal Distillation Semantic Intelligence

#### Task 12: Event Signal/Noise Triage Filter (`packages/core/src/journal/event-triage.ts`)
**Goal:** Grade incoming raw events (prompts, shell hook commands, file updates) from 0 to 4, suppressing ephemeral shell noise (`ls`, `git status`, failed builds) from the distilled knowledge base.

**Files:**
- Create: `packages/core/src/journal/event-triage.ts`
- Modify: `packages/core/src/journal/distill.ts`
- Test: `packages/core/tests/journal/event-triage.test.ts`

- [ ] **Step 1: Implement `triageEvent(event: RawEvent): Promise<number>`**:
  - Scores events on a 0–4 scale:
    - 0 = Ephemeral noise (suppressed from markdown task entries)
    - 1 = Routine operations
    - 2 = Context shifts / branch switches
    - 3 = Meaningful errors, test findings
    - 4 = Architectural pivots, user notes
- [ ] **Step 2: Update `readRawEvents` in `packages/core/src/journal/distill.ts`**:
  - Filter raw events where `triageScore === 0` from task entry rendering (retaining them in raw audit files).
- [ ] **Step 3: Write unit tests in `packages/core/tests/journal/event-triage.test.ts`**.
- [ ] **Step 4: Run triage tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/journal/event-triage.test.ts
  ```

---

#### Task 13: Semantic Task Boundary & Topic Pivot Detection (`packages/core/src/journal/topic-detector.ts`)
**Goal:** Upgrade `groupEvents` in [`topic-detector.ts`](file:///home/safiyu/Projects/kontexta/packages/core/src/journal/topic-detector.ts) to detect true semantic task pivots (`noul: true`), replacing brittle 6-word title slugs and blind session affinity.

**Files:**
- Modify: `packages/core/src/journal/topic-detector.ts`
- Test: `packages/core/tests/journal/topic-detector.test.ts`

- [ ] **Step 1: Implement `detectTopicPivot(currentTaskContext, nextEvent)`**:
  - Evaluates whether an incoming `user_prompt` or `agent_note` represents a contextual shift from the active task.
  - If pivot detected, cleanly mints a new task bucket rather than merging into the existing session bucket.
- [ ] **Step 2: Upgrade task naming**:
  - Uses `DecisionEngine.classifyChoice` to generate clean task slugs instead of mechanical regex slicing.
- [ ] **Step 3: Update `packages/core/tests/journal/topic-detector.test.ts`** with multi-topic session tests.
- [ ] **Step 4: Run topic detector tests**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/journal/topic-detector.test.ts
  ```

---

#### Task 14: Deterministic Task Categorization & Archetyping (`packages/core/src/journal/distill.ts`)
**Goal:** Classify distilled task buckets into standardized operational categories (`debugging`, `refactoring`, `infra_ops`, `feature_dev`, `research_exploration`, `documentation`) using the `choice` head, injecting clean frontmatter metadata.

**Files:**
- Modify: `packages/core/src/journal/distill.ts`
- Modify: `packages/core/src/journal/types.ts`
- Test: `packages/core/tests/journal/distill.test.ts`

- [ ] **Step 1: Add `category?: string` to `JournalFrontmatter`** in `packages/core/src/journal/types.ts`.
- [ ] **Step 2: Implement `classifyTaskCategory(events: RawEvent[])`** in `distill.ts`.
- [ ] **Step 3: Inject `category` into frontmatter** during `buildFrontmatter()`.
- [ ] **Step 4: Run distillation test suite**:
  ```bash
  pnpm --filter kxta-core test packages/core/tests/journal/distill.test.ts
  ```

---

### Phase 5: MCP Tool Surface, Configuration & End-to-End Validation

#### Task 15: MCP Tool Surface & `kontexta.json` Configuration (`apps/mcp/src/index.ts`)
**Goal:** Expose reranking, intent routing, and sufficiency verdict parameters in `files_search` and configure all settings via `kontexta.json`.

**Files:**
- Modify: `apps/mcp/src/index.ts`
- Modify: `kontexta.json`
- Test: `apps/mcp/tests/rerank-search.test.mjs`

**Configuration Schema in `kontexta.json`:**
```json
{
  "system1": {
    "device": "auto",
    "cache_dir": ".cache/models"
  },
  "search": {
    "rerank": {
      "enabled": true,
      "model": "Xenova/ms-marco-MiniLM-L-6-v2",
      "candidate_limit": 30,
      "dictionary_boost": 0.08,
      "timeout_ms": 300
    },
    "verdicts": {
      "intent_routing": true,
      "sufficiency_check": true,
      "relevance_floor": 0.15
    }
  },
  "journal": {
    "distillation": {
      "decision_engine": {
        "enabled": true,
        "event_triage": true,
        "topic_pivot_detection": true,
        "task_categorization": true
      }
    }
  }
}
```

- [ ] **Step 1: Update `files_search` tool parameter schema** in `apps/mcp/src/index.ts`:
  - `rerank?: boolean` (defaults to true if model cached/available).
  - `check_sufficiency?: boolean` (defaults to true when `include_bodies: true`).
- [ ] **Step 2: Update tool execution handler**:
  - Pass options to `bundleSearch`.
  - Report `meta.intent`, `meta.sufficiency`, and per-hit `rerank_score`.
- [ ] **Step 3: Update `admin_overview` tool** to report System 1 engine status (`ready`, `device`, `loaded_models`).
- [ ] **Step 4: Write smoke test in `apps/mcp/tests/rerank-search.test.mjs`**.
- [ ] **Step 5: Run MCP build and smoke test**:
  ```bash
  pnpm --filter kontexta-mcp build
  node apps/mcp/tests/rerank-search.test.mjs
  ```

---

#### Task 16: Comprehensive Test Suite, Retrieval Benchmarks & Documentation
**Goal:** Verify full end-to-end integration across candidate reranking, search verdicts, and journal distillation, update user documentation, and measure latency and memory under load.

**Files:**
- Create: `packages/core/tests/system1-integration.test.ts`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`

- [ ] **Step 1: Write end-to-end integration test `system1-integration.test.ts`**:
  - Test full query flow: Query $\to$ Intent Routing $\to$ FTS5 $\to$ Cross-Encoder $\to$ Soft Prior $\to$ Sufficiency Verdict $\to$ Bundle.
  - Test full journal flow: Raw Events $\to$ Triage $\to$ Pivot Detection $\to$ Task Categorization $\to$ Distilled Markdown.
  - Verify zero-regression fallback when models are disabled.
- [ ] **Step 2: Update documentation**:
  - Document `system1`, `search.rerank`, and `search.verdicts` in `docs/ROADMAP.md` and `README.md`.
- [ ] **Step 3: Run full workspace build & test suite**:
  ```bash
  pnpm build
  pnpm test
  ```

---

## 5. Comprehensive Risk Analysis & Mitigation Matrix

| Risk / Failure Mode | Severity | Impact | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Model Download Latency on Startup** | Medium | First query or distill run takes 5–10s downloading weights | 1. Non-blocking lazy prefetch on server boot.<br>2. CLI prefetch command (`kontexta models preload`).<br>3. Non-blocking fallback: if model is not cached, instantly return BM25 / mechanical results rather than freezing the request. |
| **CPU Starvation on Concurrent Searches** | High | Multiple concurrent MCP requests degrade responsiveness | 1. Truncate doc pairs to title + first 256 tokens.<br>2. Cap candidate pool at $K=30$.<br>3. Hard timeout at $300\text{ms}$ with `Promise.race`.<br>4. Process batches in micro-chunks with `setImmediate` yields. |
| **Decision Model Hallucination in Verdicts** | Medium | Erroneous "insufficient context" warning emitted on good matches | 1. Zero-temperature classification head calibration.<br>2. Sufficiency check only flags a warning, never blocks or suppresses returned content.<br>3. Agent can override via `check_sufficiency: false`. |
| **Over-Filtering Raw Journal Events** | Medium | Legitimate command outputs omitted from task notes | 1. Triage filter only suppresses grade 0 (repetitive, empty shell commands).<br>2. All raw events remain permanently recorded in JSONL raw logs; nothing is deleted. |
| **Node.js Native Binding / Architecture Drift** | Low | ONNX runtime native binary incompatible with specific Linux distro | `@huggingface/transformers` provides pure WASM fallback, or Kontexta gracefully degrades to classic FTS5 with zero process crashes. |

---

## 6. Execution Roadmap & Next Steps

When approved to proceed, execution will follow the phased order:
1. **Phase 1 (Inference Foundation & Spikes):** Implement shared cache manager in `packages/core/src/inference/` and run decision model spike.
2. **Phase 2 (Reranking Pipeline):** Build `rerank/engine.ts`, arbitrator, unbias candidate generation in `metadata`, and wire into `bundleSearch`.
3. **Phase 3 (Search Verdicts):** Implement intent router, relevance pruning, and sufficiency check.
4. **Phase 4 (Journal Distillation):** Implement event triage, semantic pivot detector, and task categorizer.
5. **Phase 5 (MCP & Verification):** Expose configuration in `kontexta.json`, wire MCP tool parameters, and run comprehensive integration tests.
