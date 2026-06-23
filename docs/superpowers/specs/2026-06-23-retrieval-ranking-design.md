# Retrieval Ranking Milestone — Design

Date: 2026-06-23
Status: Approved (pending implementation plan)

## Goal

Move Cyrus V2 retrieval from **vector-similarity-dominated** ranking to a transparent,
multi-signal **weighted reranking** model, add **retrieval reinforcement** and **temporal
urgency**, and stand up a **measurable benchmark** so ranking quality stops being a guess.

Today (`retrieve-context/ranker.ts`) the final score is effectively
`baseScore + temporalBoost`, where `baseScore = hybrid_score | (1 - similarity_distance)`.
The `llm_importance` / `system_importance` columns exist on `memory_records` but are **not
used**. There is no retrieval tracking and no offline evaluation.

This milestone is logic-first (ranking stays in `ranker.ts`, out of SQL) with the minimum
schema additions required: two reinforcement columns and one `deadline_at` column.

## Non-Goals

- No config-table for weights (YAGNI). Weights are named constants in `ranker.ts`.
- No full ML / learning-to-rank. Deterministic, explainable scoring only.
- No change to email/event RPC return shapes beyond what already exists.
- The optional end-to-end harness is **not** a CI gate.

---

## Phase A — Weighted Scoring (`ranker.ts`)

Replace the additive formula with a normalized weighted sum. Every component is clamped to
`[0,1]`. The existing Phase-15 `temporalBoost` (query-intent tie-break) is **kept** and
remains orthogonal — it nudges toward an explicitly requested time window, independent of
deadline urgency.

```
finalScore =
    W_SEM   * semantic
  + W_URG   * urgency
  + W_IMP   * importance
  + W_REC   * recency
  + W_REINF * reinforcement
  + temporalBoost            // unchanged, additive tie-break
```

**Normalized weights (named constants at top of `ranker.ts`):**

| Constant   | Value |
|------------|-------|
| `W_SEM`    | 0.50  |
| `W_URG`    | 0.20  |
| `W_IMP`    | 0.15  |
| `W_REC`    | 0.10  |
| `W_REINF`  | 0.05  |

These sum to 1.0 (true weights, not relative coefficients). Semantic stays the largest
single signal but no longer overwhelms — a deadline due tomorrow can occasionally outrank a
slightly-more-similar but non-urgent memory, which is the intended behavior.

**Component definitions:**

- `semantic` — existing `baseScore` (`hybrid_score`, else `1 - similarity_distance`), clamped.
- `importance` — `max(llm_importance, system_importance)`, already in `[0,1]`. Emails/events
  have no importance signal → default `0.5`.
- `recency` — exponential decay on the item's timestamp
  (`created_at` for memories, `received_at` for emails, `start_time` for events):
  `recency = exp(-ageDays / RECENCY_HALFLIFE_DAYS)` with `RECENCY_HALFLIFE_DAYS` constant.
- `reinforcement` — saturating: `log1p(retrieval_count) / log1p(REINF_CAP)`, clamped to 1.0.
  A 20-mention collaborator outranks a one-off, without runaway from very high counts.
- `urgency` — piecewise, see Phase C.

**Debug metadata.** Every candidate carries a `_scores` object with each component plus the
final, so ranking failures are diagnosable:

```json
{ "semantic": 0.81, "importance": 0.62, "recency": 0.41,
  "reinforcement": 0.18, "urgency": 1.00, "final": 0.74 }
```

---

## Phase B — Memory Reinforcement

**Schema migration** (idempotent, `ADD COLUMN IF NOT EXISTS`):

```sql
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS retrieval_count   INTEGER DEFAULT 0;
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;
```

**Write path — final-context only (critical).** Reinforcement is **not** incremented for
every candidate above the 0.3 assembly threshold. It is incremented **only for the memories
that survive into the final assembled context** sent to the LLM — i.e. the actual top-N that
`assembler.ts` includes after the candidate → rerank → assemble pipeline. Entering the
candidate pool is not proof of usefulness; being chosen for the answer is the success signal.

- New service-role RPC `record_memory_retrievals(ids uuid[])`:
  `UPDATE memory_records SET retrieval_count = retrieval_count + 1, last_retrieved_at = now()
   WHERE id = ANY(ids)`.
- `retrieve-context/index.ts` collects the IDs of the **memory** rows actually placed in the
  assembled context (from `assembler.ts` output, not the pre-assembly candidate list) and
  calls the RPC **fire-and-forget** (not awaited on the response path) so query latency is
  unchanged. Only memory rows are reinforced (emails/events have no such column).

---

## Phase C — Temporal Urgency

**Schema migration** (idempotent):

```sql
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
```

`deadline_at` is **separate from `expires_at`**. `expires_at` remains pure lifecycle (the
migration-031 filter that drops expired memories is untouched). `deadline_at` is a ranking
signal only and is never used to filter rows out, so a deadline memory stays retrievable
through and just past its critical window.

- **Extractor change** (`memory-extraction` + `_shared/prompts.ts`): populate `deadline_at`
  when the LLM detects a concrete due-date ("submit by July 10"). Documented constraint: the
  extractor must not set `expires_at` earlier than `deadline_at`, so a deadline memory is not
  lifecycle-expired before its deadline passes.

**Urgency curve — piecewise (not exponential).** `d` = days until deadline
(`deadline_at` for memories, `start_time` for events). Chosen for explainability: when a
ranking looks wrong, the urgency bucket is immediately readable.

Upcoming:

| Days to deadline `d` | urgency |
|----------------------|---------|
| `d > 30`             | 0.0     |
| `30 ≥ d > 14`        | 0.2     |
| `14 ≥ d > 7`         | 0.4     |
| `7 ≥ d > 3`          | 0.7     |
| `3 ≥ d ≥ 0`          | 1.0     |

Post-deadline (overdue, `d` negative → `late = -d` days late):

| Days late `late` | urgency |
|------------------|---------|
| `0 ≤ late ≤ 2`   | 1.0     |
| `2 < late ≤ 7`   | 0.5     |
| `late > 7`       | 0.0     |

Items with no deadline/start_time → `urgency = 0`.

Worked example (deadline July 10): June 23 → `d=17` → 0.2 (low); July 8 → `d=2` → 1.0
(critical — the table reaches 1.0 at `d≤3`); July 10 → `d=0` → 1.0 (critical); July 12 →
`late=2` → 1.0; July 18 → `late=8` → 0.0.

---

## Phase D — RPC / Signal Plumbing

The ranker needs raw signals the RPCs don't currently return.

- `CREATE OR REPLACE` (with a guarded `DROP FUNCTION` since the return shape changes) for
  **`hybrid_search_memories`** and **`graph_expand_memories`** to additionally return:
  `llm_importance, system_importance, retrieval_count, last_retrieved_at, deadline_at`.
- **Email/event RPCs unchanged** — no importance column; their `recency`/`urgency` derive
  from existing `received_at` / `start_time`.
- All migrations idempotent and drop-guarded so a clean `supabase db reset` (the CI gate)
  stays green. Validation SQL (`scripts/validate-*.sql`) updated if it asserts return shapes.

---

## Phase E — Benchmark & Evaluation

Two layers. Start small — **50 questions, not 100** — to avoid authoring fixtures against an
unstable scoring model that we'd then rewrite. Expand after the model stabilizes.

**Metrics module** `supabase/functions/retrieve-context/eval/metrics.ts` (pure, TDD'd first):
`recallAtK`, `mrr`, `ndcgAtK`. Required metrics: **Recall@5, Recall@10, MRR, NDCG@10**.

**Deterministic ranker benchmark** (CI gate, Deno test, no network/LLM):
- `eval/fixtures/` — synthetic corpus + **50 labeled questions**, split:
  **20 retrieval, 20 ranking, 10 urgency.**
- Each fixture: a candidate pool with explicit signal values
  (`semantic`, `importance`, `deadline_at`, `retrieval_count`, timestamps) + the set of
  relevant IDs (and, for ranking cases, the expected order).
- Feeds `rankResults()` directly, computes the four metrics, asserts against baseline
  thresholds recorded in the spec/test so regressions fail CI.
- Urgency fixtures pin "today" deterministically (injected clock, no `Date.now()` ambiguity)
  to exercise the piecewise curve across buckets.

**Optional manual harness** `scripts/benchmark-retrieval.mjs` (opt-in, documented, NOT in CI):
end-to-end against a local seeded Supabase stack with real embeddings, for spot-checking the
full RPC + ranker recall.

---

## Testing & Sequencing (TDD)

1. `eval/metrics.ts` — unit tests against hand-computed Recall/MRR/NDCG cases. (No deps.)
2. Ranker scoring — extend the `temporal.test.ts` pattern: component clamping, weighted sum,
   piecewise urgency buckets (incl. overdue), saturating reinforcement, `_scores` metadata.
3. Migrations — add columns + RPC shape changes; validate via `supabase db reset` locally and
   `deno check` on every changed function.
4. Reinforcement write path — assert only final-context memory IDs are passed to the RPC and
   the call is fire-and-forget (latency unaffected).
5. Benchmark fixtures (50) — author, wire as CI Deno test, set baseline thresholds.
6. Optional manual harness — last, non-gating.

Order matters: metrics + ranker tests stabilize the model **before** fixtures are authored.

## Risks / Notes

- **Fixture authoring** is the main human-effort item; capped at 50 and deliberately
  sequenced after the model stabilizes.
- **Schema additions** are justified by the milestone (per CLAUDE.md, schema changes allowed
  when the task requires them); kept to 3 columns + RPC reshape, all idempotent.
- **`deadline_at` population** depends on extractor LLM quality; ranking degrades gracefully
  (urgency=0) when absent, so missing deadlines never break retrieval.
- **Weight tuning** is a constant-edit + rerun-benchmark loop, no migration.
