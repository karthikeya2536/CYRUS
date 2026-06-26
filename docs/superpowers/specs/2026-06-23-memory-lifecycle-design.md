# Long-Term Memory Lifecycle System — Design Document

**Status:** Architecture only (no implementation)
**Date:** 2026-06-23
**Scope:** Cyrus V2 memory layer (`memory_records`, `retrieve-context/ranker.ts`, `llm-worker`, `llm_jobs` + pg_cron). Cross-references the Memory Consolidation (`033` / `2026-06-23-memory-consolidation-design.md`) and Knowledge Graph (`034` / `2026-06-23-knowledge-graph-retrieval-design.md`) designs.

---

## 1. Problem

Memories accumulate forever and are treated as uniformly "live." Today there are exactly **two** lifecycle mechanics, and they are both binary edges, not a gradient:

- **`expires_at`** (Phase 31, `031_memory_expiry_enforcement.sql:51`): retrieval RPCs filter `(expires_at IS NULL OR expires_at > now())`. This is a *hard, deterministic* cutoff computed at extraction time from category (`llm-worker/index.ts:63-79 computeExpiresAt`): event→end_time, deadline→deadline+7d grace, everything else→`NULL` (durable forever).
- **`active`** (`011_reconstruct_schema.sql:51`): a soft-delete flag. Nothing in the running system ever sets it to `FALSE` automatically — it is a manual/never escape hatch.

So the store has two terminal states (live, hard-expired) and a manual kill switch, but **no notion of a memory becoming gradually less relevant**. Consequences:

1. A durable memory ("prefers afternoon meetings") and a stale one ("was debugging the auth bug last March") are equally retrievable forever. `expires_at` is `NULL` for both — neither ever leaves the hot set.
2. The only retention signal that decays is `recency` in the ranker (`ranker.ts:87-94`, `exp(-ageDays/30)`, weight `W_REC = 0.10`). At weight 0.10 a 1-year-old memory still scores `0.50*semantic + …` and can win on semantics alone. Age never *removes* anything; it only nudges.
3. Reinforcement exists (Phase 32, `record_memory_retrievals`, `032_retrieval_ranking_signals.sql:117-127`) but only *adds* score (`W_REINF = 0.05`). A frequently-retrieved memory and a never-retrieved one age identically. Reinforcement and decay never interact.
4. Near-duplicate stale facts pile up. Phase 14 dedup (`018_memory_dedup.sql`) only fires *at extraction time*, same-category, distance ≤ 0.15. Two facts that drift into near-duplicates months apart are never reconciled.

**Lifecycle** adds a continuous **relevance gradient** and a small **state machine** on top of `memory_records` so memories *decay → go dormant → archive → resurrect*, all as reversible metadata transitions, **never deletion**, and feed the existing ranker additively without retuning its weights.

### Design constraints (from the codebase)

- `CLAUDE.md`: *avoid schema changes unless the task requires one; prefer logic over new columns/tables.* Lifecycle genuinely needs a small amount of persistent state (a `lifecycle_state`, a computed `relevance_score`, and an audit table). Every added column is justified in §7; we reuse existing columns (`retrieval_count`, `last_retrieved_at`, `llm_importance`, `system_importance`, `occurrence_count`, `last_seen_at`, `created_at`, `active`, `expires_at`) wherever possible and add the **minimum**.
- Migrations idempotent (`IF NOT EXISTS`, policy drop-guards); CI runs a clean `supabase db reset`. This doc reserves **migration `035`**.
- RLS everywhere (`auth.uid() = user_id`); the sweep runs as `supabaseAdmin` (service-role) and must filter `user_id` explicitly.
- Long work is **never inline** — it goes through `llm_jobs` + `llm-worker` (reclaim → claim → retry → dead-letter invariants, `llm-worker` per CLAUDE.md). Lifecycle adds **one** new `job_type` (`memory_lifecycle`), free TEXT, no enum migration.
- The sweep needs **no LLM** for its core path (decay/archival are pure arithmetic); LLM is used only for the optional stale-near-duplicate merge adjudication, degrading via the `rule-engine` sentinel exactly like `ruleBasedExtraction`.

---

## 2. Core principle: lifecycle is *reversible, additive metadata over an immutable source*

```
                     ┌──────────────────────────────────────────────┐
  SOURCE OF TRUTH ─► │  memory_records.content  (NEVER mutated by    │
  (content frozen)   │  lifecycle; only metadata columns transition) │
                     └───────────────┬──────────────────────────────┘
                                     │  + retrieval_count / last_retrieved_at (Phase 32)
                                     │  + occurrence_count / last_seen_at (Phase 14)
                                     ▼
                     ┌──────────────────────────────────────────────┐
  LIFECYCLE LAYER ─► │  NEW cols:  lifecycle_state, relevance_score, │
  (additive,         │             relevance_computed_at,            │
   reversible)       │             archived_at, resurrected_count    │
                     │  NEW table: memory_lifecycle_audit (undo log) │
                     └───────────────┬──────────────────────────────┘
                                     ▼
                     ┌──────────────────────────────────────────────┐
  SWEEP (pg_cron) ─► │  job_type 'memory_lifecycle': recompute       │
                     │  relevance, transition states, prune cluster  │
                     │  members, signal graph edges. STATE ONLY.     │
                     └───────────────┬──────────────────────────────┘
                                     ▼
                     ┌──────────────────────────────────────────────┐
  QUERY TIME      ─► │  retrieval RPCs exclude archived/expired      │
                     │  (extends the existing expires_at guard);     │
                     │  a query HIT can resurrect an archived row    │
                     └──────────────────────────────────────────────┘
```

The invariant that makes everything safe: **the lifecycle layer only ever writes metadata columns and the audit table; it has no write path to `content`, and every transition is reversible.** Archival is `lifecycle_state = 'archived'`, not a `DELETE` and not even `active = FALSE`. Dropping the new columns + setting all states to `active` returns the system to today's exact behavior (§9 rollback).

---

## 3. Lifecycle state machine

We introduce a single enumerated `lifecycle_state` with **four** states. They are distinct from, and layered on top of, the existing `active` boolean and `expires_at` timestamp — those keep their current meaning; lifecycle never overrides a hard expiry.

```
                          retrieval HIT / new matching evidence
                       ┌────────────────────────────────────────┐
                       │                                         │
                       ▼                                         │
   (extraction)   ┌─────────┐   relevance < DORMANT_T      ┌──────────┐
   ───────────►   │ active  │ ───────────────────────────► │ dormant  │
                  │         │ ◄─────────────────────────── │          │
                  └────┬────┘   reinforce / relevance↑     └────┬─────┘
                       │                                        │ stays < DORMANT_T
                       │ relevance < ARCHIVE_T                   │ for ARCHIVE_GRACE_DAYS
                       │ (fast path, e.g. importance≈0)         ▼
                       │                                   ┌──────────┐
                       └──────────────────────────────►   │ archived │
                                                          │ (cold)   │
                            query HIT / new evidence       └────┬─────┘
                       ┌──────────────────────────────────────┘
                       │  RESURRECT: archived → active
                       ▼
                  ┌─────────┐
                  │ active  │   ... and the cycle continues
                  └─────────┘

   ┌──────────┐   hard, deterministic, set at extraction time (computeExpiresAt)
   │ expired  │   — orthogonal terminal state. `expires_at <= now()`. The sweep
   └──────────┘   labels these for observability but NEVER resurrects them, and
                  retrieval already excludes them (031). Re-extraction of the same
                  source can create a NEW row; the expired one stays as history.
```

| state | meaning | retrievable? | how reached | reversible? |
|---|---|---|---|---|
| `active` | hot, normal | yes | extraction; resurrection; reinforcement lift | — |
| `dormant` | cooling; still retrievable but flagged, eligible for archival | yes | relevance drops below `DORMANT_T` | yes (reinforce/evidence → active) |
| `archived` | cold; **excluded from retrieval** but content preserved | **no** (until resurrected) | stayed dormant past grace, or fast-path low relevance | yes (resurrect → active) |
| `expired` | hard lifecycle expiry (`expires_at <= now()`) | no (031 guard) | deterministic, at extraction | **no** (terminal; orthogonal to the sweep) |

`expired` is a *label the sweep applies for observability/graph signalling* — the actual exclusion is already done by the `expires_at` filter in `031`. The sweep never moves a row *out of* `expired`. `active`/`dormant`/`archived` are the states the sweep actively manages.

**Relationship to `active` boolean.** `active = FALSE` remains the manual hard soft-delete (user deletion, abuse). It is a **superset kill switch**: an `active = FALSE` row is invisible regardless of `lifecycle_state`. The sweep never sets `active = FALSE` (that would conflate "archived/cold" with "deleted"). Retrieval exclusion for `archived` is a *new, separate* predicate (§5) so archival stays cleanly reversible without touching `active`.

---

## 4. Decay & relevance model

### 4.1 The unified `relevance_score`

A single scalar in `[0, 1]`, recomputed by the sweep and stored on the row (`relevance_score`, `relevance_computed_at`). It is **not** the ranker's `finalScore` — it is a *retention* signal (does this memory deserve to stay hot?), whereas `finalScore` is a *query-time* signal (does this memory answer *this* query?). They share inputs but serve different masters.

```
relevance_score =
      W_AGE  * decayFactor(ageDays)
    + W_IMP  * importance
    + W_REINF_L * reinforcementRetention(retrieval_count, daysSinceLastRetrieval)
    + W_OCC  * occurrenceFactor(occurrence_count)

with retention weights (sum = 1.0, distinct from ranker weights):
      W_AGE      = 0.35
      W_IMP      = 0.30
      W_REINF_L  = 0.25
      W_OCC      = 0.10
```

Each component is `clamp01`. Components:

- **`decayFactor(ageDays)`** — exponential decay on *effective* age (see §4.2 for the reinforcement extension):
  ```
  decayFactor = exp(-effectiveAgeDays / DECAY_HALFLIFE_DAYS)     DECAY_HALFLIFE_DAYS = 90
  ```
  A 90-day-old, never-touched memory decays to `0.37`; 180 days → `0.14`. We deliberately use a **longer half-life (90d) than the ranker's recency half-life (30d**, `RECENCY_HALFLIFE_DAYS`, `ranker.ts:60`): the ranker punishes old memories for *this query*; retention should be more forgiving so that important-but-old facts survive.

- **`importance`** — reuse the ranker's exact definition (`ranker.ts:76-80`): `max(llm_importance, system_importance)`, default `0.5` when absent. This is the dominant survival signal: a high-importance memory (0.9) carries `0.30*0.9 = 0.27` floor regardless of age, which is what stops "starving rarely-but-important memories."

- **`reinforcementRetention`** — see §4.2; combines `retrieval_count` (magnitude) and `last_retrieved_at` (freshness of the last hit).

- **`occurrenceFactor`** — `log1p(occurrence_count)/log1p(OCC_CAP)`, `OCC_CAP = 10`. A fact merged/re-seen many times (Phase 14 bumps `occurrence_count`, `018`) is corroborated and worth keeping. Small weight (0.10) so it can't alone prevent archival of junk.

### 4.2 Reinforcement ⇄ decay interaction (the core math)

Reinforcement must **counteract** decay, not merely add to score. We model this as **each retrieval extends the memory's effective lifetime** — a half-life that resets/slides on use. Concretely, decay runs on `effectiveAgeDays`, where a recent retrieval pulls the clock forward:

```
lastTouch   = max(created_at, last_retrieved_at, last_seen_at)
effectiveAgeDays = (now - lastTouch) / 1 day

reinforcementRetention(c, daysSinceLastRetrieval) =
    magnitude * freshness
      magnitude = log1p(c) / log1p(REINF_CAP)          REINF_CAP = 50   (reuse ranker cap, ranker.ts:61)
      freshness = exp(-daysSinceLastRetrieval / REINF_FRESH_HALFLIFE)   REINF_FRESH_HALFLIFE = 45
```

Two distinct effects, intentionally:

1. **`effectiveAgeDays` slide** (in `decayFactor`): a retrieval resets the decay clock. A memory retrieved yesterday has `effectiveAgeDays ≈ 0` → `decayFactor ≈ 1.0` regardless of `created_at`. This is the "each retrieval extends effective lifetime" half-life model.
2. **`reinforcementRetention` term**: rewards *sustained* use. `magnitude` grows with total retrievals (log, saturating), `freshness` decays if the memory hasn't been retrieved lately — so a memory that *was* hot a year ago but is now untouched loses the reinforcement term and falls back on age+importance.

**Guard against runaway retention of junk.** Reinforcement is bounded two ways: `magnitude` saturates at `REINF_CAP = 50` (log curve), and `W_REINF_L = 0.25` caps its total contribution at 0.25. A spammy low-importance memory that somehow gets retrieved cannot exceed `0.25 (reinf) + 0.10 (occ) + tiny age = ~0.35`, which is still below `DORMANT_T` (§6) → it cools regardless. Conversely importance alone (`0.30 * importance`) plus a non-zero age floor keeps a never-retrieved but important memory above the archival line.

**Guard against starving rarely-but-important memories.** Importance is the largest single weight (0.30) and is decay-independent. A memory with `importance = 0.9`, never retrieved, at 180 days: `relevance = 0.35*0.14 + 0.30*0.9 + 0 + small ≈ 0.32` → stays `dormant` (retrievable), never `archived`, because `0.32 > ARCHIVE_T`. Exactly the intended behavior.

### 4.3 How `relevance_score` feeds the ranker — additively, no retuning

The ranker's five weights (`W_SEM 0.50, W_URG 0.20, W_IMP 0.15, W_REC 0.10, W_REINF 0.05`, `ranker.ts:54-58`) **sum to 1.0 and stay unchanged**. Lifecycle does **not** add a sixth weighted term into that sum (that would force a re-benchmark — forbidden lightly). Instead it acts as an **additive tiebreaker bump**, mirroring `temporalBoost` which is already added *outside* the weighted sum (`ranker.ts:148-154`):

```
finalScore = W_SEM*sem + W_URG*urg + W_IMP*imp + W_REC*rec + W_REINF*reinf
             + temporalBoost
             + W_LIFE * (relevance_score - 0.5)        // NEW, additive, default W_LIFE = 0.04
```

- Centered at 0.5 so it is signed: a high-relevance memory gets a small positive nudge, a cooling one a small negative nudge, and a neutral one (0.5) contributes nothing — so the *existing 50-case benchmark stays green by construction at `W_LIFE = 0`* and we ship the bump behind a flag.
- Magnitude `0.04` is below `W_REINF (0.05)`, so it can break ties toward fresher memories but never reorders against a clear semantic winner — the same discipline `calculateTemporalBoost` follows (`ranker.ts:29-31`).
- The RPCs must surface `relevance_score` (§5) for this to be available at rank time, alongside the columns `032` already surfaces.

---

## 5. Archival model & retrieval exclusion

### 5.1 Where archived rows live

**Same table, flagged** — not a cold `memory_archive` table. Rationale (tradeoff in §10):

- Honors "minimize schema change": no second table, no data movement job, no dual-write.
- Resurrection becomes a single `UPDATE … SET lifecycle_state='active'` — no cross-table INSERT/DELETE that could lose `embedding`, `entity_mentions` FKs, or cluster membership.
- `entity_mentions`, `memory_cluster_members` (033), and graph nodes/edges (034) all FK to `memory_records.id`; keeping the row in place means archival never breaks those references — it just changes whether retrieval *includes* it.

The cost (archived rows still occupy the ivfflat index) is mitigated by a **partial index** keyed on the hot set (§7) and the fact that archival is expected to be a minority of rows.

### 5.2 Retrieval exclusion — extend the existing guard

The exclusion mirrors the `expires_at` pattern already in `031`. Each retrieval RPC gains one predicate:

```sql
-- in hybrid_search_memories (032:50-52) and graph_expand_memories (032:104-106):
WHERE m.user_id = auth.uid()
  AND m.active = TRUE
  AND (m.expires_at IS NULL OR m.expires_at > now())
  AND m.lifecycle_state <> 'archived'        -- NEW: cold rows excluded, like expired
```

`dormant` rows are **still retrievable** — dormancy is a warning, not an exclusion. Only `archived` is excluded. This is the minimal change and exactly parallels how `031` added the expiry guard without altering signatures' *inputs* (here we don't even change signatures — only the WHERE body, so `CREATE OR REPLACE` keeps grants).

The dedup candidate RPC `match_memory_candidates` (`018:40-44`) currently filters `active = TRUE`; the lifecycle sweep's stale-merge step (§6) deliberately **includes** dormant/archived candidates by calling a variant that drops the `lifecycle_state` guard, so it can reconcile cold near-duplicates (see §6.3).

### 5.3 The sweep job

A pg_cron-scheduled `memory_lifecycle` job, modeled on the `llm-worker` drain (`022_schedule_llm_worker.sql` pattern) and provisioned the same Vault way (`scripts/setup-worker.sql`, `project_url` + `worker_secret`; no-op if absent so `db reset` stays green).

```
pg_cron (e.g. every 6h) ──► enqueue llm_jobs(job_type='memory_lifecycle', scope)
                              │
llm-worker drains it (same reclaim→claim→retry→dead-letter loop, one new
dispatch branch; MAX_JOBS_PER_RUN=5 honored; per-user chunking under the 55s budget)
                              │
handler, per user batch:
  1. recompute relevance_score for candidate rows (active/dormant) — pure SQL/arith
  2. transition states per §6 rules; stamp relevance_computed_at
  3. on active→archived: set archived_at; prune memory_cluster_members (033);
     signal knowledge-graph edges (034) to mark edges touching this memory invalid
  4. on resurrect (driven separately by query path, §8): clear archived_at, ++resurrected_count
  5. (optional, LLM) stale near-duplicate merge among cold rows (§6.3), via LLMRouter
     with rule-engine fallback = "do not merge"
  6. append memory_lifecycle_audit row per transition
```

Steps 1–4, 6 are deterministic and LLM-free. Only step 5 touches the router and degrades gracefully. The sweep is **chunked and resumable**: it processes rows in `(user_id, id)` order with a cursor in the job payload, re-enqueuing a continuation job if it hits the per-run budget — the same resumability the consolidation backfill uses.

---

## 6. Retention & archival rules (concrete thresholds)

All thresholds are env-tunable named constants (the project's convention, e.g. `DEDUP_DISTANCE_THRESHOLD`). Defaults:

| constant | default | role |
|---|---|---|
| `DORMANT_T` | 0.40 | relevance below → `active` becomes `dormant` |
| `REACTIVATE_T` | 0.55 | relevance above (after reinforcement/evidence) → `dormant`/`archived` → `active` |
| `ARCHIVE_T` | 0.20 | relevance below → eligible for `archived` |
| `ARCHIVE_GRACE_DAYS` | 30 | must stay `dormant` this long before archival (hysteresis) |
| `DECAY_HALFLIFE_DAYS` | 90 | retention decay half-life |
| `REINF_FRESH_HALFLIFE` | 45 | freshness decay of the reinforcement term |
| `REINF_CAP` | 50 | reuse ranker cap (`ranker.ts:61`) |
| `OCC_CAP` | 10 | occurrence saturation |
| `W_LIFE` | 0.04 | additive ranker bump (ship at 0.0, enable after re-benchmark) |

The gap between `DORMANT_T (0.40)` and `REACTIVATE_T (0.55)` is **deliberate hysteresis** — a memory hovering at 0.41 doesn't flap between states each sweep; it must climb past 0.55 to reactivate and fall below 0.40 to cool.

### 6.1 Retention (decay) rules

| current state | condition | action | audit `action` |
|---|---|---|---|
| `active` | `relevance < DORMANT_T` AND `expires_at` not hit | → `dormant` | `cooled` |
| `active` | `expires_at <= now()` | → label `expired` (retrieval already excludes) | `expired` |
| `dormant` | `relevance ≥ REACTIVATE_T` (reinforcement/new evidence lifted it) | → `active` | `reactivated` |
| `dormant` | still `< DORMANT_T` but `≥ ARCHIVE_T` | stay `dormant` (recompute only) | `recomputed` |
| any | high `importance ≥ 0.85` | **floor**: never archive; cap at `dormant` | `importance_floor` |

### 6.2 Archival rules

| current state | condition | action | audit `action` |
|---|---|---|---|
| `dormant` | `relevance < ARCHIVE_T` AND has been `dormant ≥ ARCHIVE_GRACE_DAYS` AND `importance < 0.85` | → `archived`; set `archived_at`; prune cluster members; invalidate graph edges | `archived` |
| `active` | fast path: `relevance < ARCHIVE_T` AND `importance < 0.30` AND `ageDays > 2*DECAY_HALFLIFE_DAYS` (≥180d) | → `archived` (skip dormancy for obvious junk) | `archived` |
| `archived` | new matching evidence OR query HIT OR `relevance ≥ REACTIVATE_T` | → `active` (resurrection, §8); `++resurrected_count` | `resurrected` |
| `archived` | none | stay `archived` (excluded from retrieval) | — |

**Retention tiers driven by `retrieval_count` + importance** (answering "how should `retrieval_count` affect retention?"): the table below summarizes the emergent tiers (computed, not hard-coded — they fall out of the formula, shown for intuition at age 180d, never-recently-retrieved):

| tier | importance | retrieval_count | outcome at 180d |
|---|---|---|---|
| **pinned** | ≥ 0.85 | any | never archived (`importance_floor`) — stays `dormant` at worst |
| **hot** | any | high (≥ ~15) recent | reinforcement + slide keep it `active` |
| **warm** | ≥ 0.50 | low/none | `dormant`, retrievable, survives |
| **cold junk** | < 0.30 | none | `archived` |

### 6.3 Merge at lifecycle time (relation to Phase 14 dedup)

Phase 14 dedup (`018`) is *extraction-time, same-category, distance ≤ 0.15, never deletes*. Lifecycle merge is a **complementary, low-frequency reconciliation of cold near-duplicates** that Phase 14 missed because the two facts arrived weeks apart:

- Only runs in the sweep, only among rows already `dormant`/`archived` for a user.
- Reuses `match_memory_candidates` (`018:15-46`) semantics (same-category guard preserved) but against the cold set; on a confirmed duplicate it follows the **exact** Phase 14 merge contract: `occurrence_count++`, `confidence_score = min(100, +5)`, `last_seen_at = now()`, INSERT into `memory_merge_audit` — and **never deletes content**. The surviving canonical may be *resurrected* if the merge lifts its `relevance_score` past `REACTIVATE_T`.
- LLM adjudication via `LLMRouter`; `rule-engine` sentinel → **do not merge** (conservative, matches consolidation §6 Gate C default).

Lifecycle does **not** reinvent dedup — it reuses its RPC and audit table, adding only the trigger condition (cold, stale).

---

## 7. Storage model (additive, minimal)

Per `CLAUDE.md`, we add the **fewest** columns that lifecycle genuinely needs, plus one audit table mirroring `memory_merge_audit`.

### 7.1 New columns on `memory_records` (justified individually)

| column | type | default | why it can't reuse an existing column |
|---|---|---|---|
| `lifecycle_state` | TEXT | `'active'` | The state machine has 4 states; `active` (bool) + `expires_at` only express 2.5 of them. Backfilled deterministically (§8). A CHECK constrains it to `active\|dormant\|archived\|expired`. |
| `relevance_score` | DOUBLE PRECISION | `NULL` | The unified retention scalar; no existing column holds it. `NULL` = "not yet computed" → backfill job fills it. |
| `relevance_computed_at` | TIMESTAMPTZ | `NULL` | Staleness signal for the sweep (skip rows computed < N hours ago). |
| `archived_at` | TIMESTAMPTZ | `NULL` | Marks when archival happened; needed for the `ARCHIVE_GRACE_DAYS` hysteresis and for observability/rollback windows. Distinct from `last_seen_at` (which dedup bumps). |
| `resurrected_count` | INTEGER | `0` | Counts resurrections; an audit/observability + anti-thrash signal (a row resurrected many times is genuinely important — feeds a future importance lift). |

**Reused (no new column):** `retrieval_count`, `last_retrieved_at` (Phase 32, `032`), `occurrence_count`, `last_seen_at`, `confidence_score` (`011`), `llm_importance`, `system_importance`, `created_at`, `active`, `expires_at`, `deadline_at`. The decay/relevance math is built entirely from these plus the five new metadata columns.

We deliberately **do not** add a `dormant_since` column — it is derivable as the `cooled` audit row's `created_at`, and the grace check reads that.

### 7.2 New table: `memory_lifecycle_audit` (append-only undo log)

Mirrors `memory_merge_audit` (`018:52-72`) exactly in shape and policy.

| column | type | purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL → auth.users ON DELETE CASCADE | RLS |
| `memory_id` | UUID FK → memory_records ON DELETE CASCADE | the affected row |
| `from_state` | TEXT | prior `lifecycle_state` |
| `to_state` | TEXT | new `lifecycle_state` (NULL if `recomputed` only) |
| `relevance_before` | DOUBLE PRECISION | score that drove the transition |
| `relevance_after` | DOUBLE PRECISION | |
| `action` | TEXT | `cooled\|archived\|reactivated\|resurrected\|expired\|recomputed\|importance_floor` |
| `trigger` | TEXT | `sweep\|query_hit\|new_evidence\|merge` — what caused it |
| `detail` | JSONB | component breakdown (age/imp/reinf/occ) — the explainability snapshot |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

RLS: `ENABLE ROW LEVEL SECURITY`; users `SELECT` their own (`auth.uid() = user_id`); **no** insert/update/delete policy (service-role sweep writes via `supabaseAdmin`). This is the **undo log** (§9 Tier 3) and the observability surface.

### 7.3 Indexes (all `IF NOT EXISTS`)

```sql
-- Sweep candidate scan: find rows needing recompute, user-scoped, ordered.
CREATE INDEX IF NOT EXISTS idx_memory_records_lifecycle
  ON public.memory_records (user_id, lifecycle_state, relevance_computed_at);

-- Partial index on the HOT set keeps retrieval's new exclusion predicate cheap
-- and shrinks the working set the ivfflat is effectively probing against.
CREATE INDEX IF NOT EXISTS idx_memory_records_hot
  ON public.memory_records (user_id)
  WHERE active = TRUE AND lifecycle_state <> 'archived';

-- Audit read path (mirrors idx_memory_merge_audit_user, 018:71-72).
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_audit_user
  ON public.memory_lifecycle_audit (user_id, created_at DESC);
```

### 7.4 Cross-design signalling

- **Consolidation (033):** when a memory is archived, the sweep prunes its `memory_cluster_members` rows (which are `ON DELETE CASCADE` from `memory_records`, but archival isn't a delete — so the sweep issues an explicit prune and enqueues a `memory_consolidation` re-materialization for affected `cluster_key`s so the cluster summary self-heals). **Guard:** a memory that is the sole anchor of an *active* cluster is held at `dormant` (not archived) until the cluster is re-consolidated — archival must not orphan a live profile.
- **Knowledge graph (034):** on `active→dormant→archived` and on `resurrected`, the sweep writes a signal (a column flag or a small edge-validity update) so graph edges touching the memory reflect its retrieval state — expired/archived memories should not contribute live edges; resurrection re-validates them.

---

## 8. Reactivation & resurrection

Two reversal paths, both audited, both reversible.

### 8.1 Reactivation (`dormant → active`)

The *cheap* path, no resurrection bookkeeping: a `dormant` row whose recomputed `relevance_score ≥ REACTIVATE_T` (0.55) goes back to `active` in the next sweep. This is driven by:

- **Reinforcement:** a query retrieved it (it was still retrievable while dormant), so `record_memory_retrievals` bumped `retrieval_count`/`last_retrieved_at` (`032:117-127`), which raises the reinforcement term *and* slides `effectiveAgeDays` toward 0 → relevance jumps. This is the primary "reinforcement counteracts decay" loop made concrete.
- **New evidence:** extraction merged a duplicate (Phase 14), bumping `occurrence_count`/`last_seen_at` → `occurrenceFactor` and the age slide lift relevance.

### 8.2 Resurrection (`archived → active`)

The *expensive* path — an `archived` row is, by §5.2, **excluded from retrieval**, so it can't be reinforced by a normal query hit. Resurrection therefore needs an explicit trigger:

| trigger | evidence | mechanism |
|---|---|---|
| **New matching evidence** | extraction produces a memory whose `match_memory_candidates` nearest neighbor is an archived row within `DEDUP_DISTANCE_THRESHOLD` | the dedup path, instead of merging into a cold row silently, **resurrects** the canonical (`lifecycle_state='active'`, `archived_at=NULL`, `++resurrected_count`) and applies the Phase 14 merge bumps. The fact became relevant again. |
| **Explicit recall / archive search** | a future "search my archive" feature, or a graph hop (034) that reaches an archived node | a dedicated `resurrect_memories(p_user_id, ids[])` service-role RPC (mirrors `record_memory_retrievals`) flips state + audits with `trigger='query_hit'`. Until that feature ships, archived rows are simply cold. |
| **Sweep relevance lift** | importance was raised (e.g. `resurrected_count` feedback, or a manual importance edit) so recomputed relevance ≥ `REACTIVATE_T` | sweep transition `archived→active`, `trigger='sweep'` |

**Audit & anti-thrash.** Every resurrection writes a `memory_lifecycle_audit` row (`action='resurrected'`). `resurrected_count` lets us detect a row that keeps cooling and resurrecting — a future rule can lift its `system_importance` so it stops thrashing (the system *learns* the memory is durable). Resurrection never duplicates content — it flips the existing row's state.

---

## 9. Rollback plan

Three tiers, cheapest first — all possible because lifecycle is reversible metadata over an immutable source (§2).

### Tier 1 — Feature flags (instant, no data change)

- `LIFECYCLE_SWEEP_ENABLED` (read by the worker dispatch branch): off → no state transitions ever happen; rows stay wherever they are. The pg_cron schedule can also simply not be provisioned (Vault no-op pattern).
- `LIFECYCLE_RETRIEVAL_EXCLUSION_ENABLED` (read by the RPC bodies via a settings row, or shipped as a second `CREATE OR REPLACE` variant): off → drop the `lifecycle_state <> 'archived'` predicate so **everything is retrievable** exactly as today, even rows the sweep already moved to `archived`. This is the critical safety lever: archival becomes a no-op at read time instantly, with no data rewrite.
- `W_LIFE = 0` (default): the ranker bump contributes nothing, so ranking is byte-identical to today and the 50-case benchmark stays green. Enabling it is a separate, benchmark-gated decision.

### Tier 2 — Reset states (full reversal, no schema drop)

A single service-role `UPDATE`:
```sql
UPDATE public.memory_records
SET lifecycle_state = 'active', relevance_score = NULL,
    archived_at = NULL, relevance_computed_at = NULL;
```
Returns every memory to the hot set. Content was never touched; `active`/`expires_at` were never altered by the sweep, so hard expiry still works. The audit log is retained as history.

### Tier 3 — Drop the layer (down-migration)

Because lifecycle is additive columns + one table:
```sql
DROP TABLE IF EXISTS public.memory_lifecycle_audit;
DROP INDEX IF EXISTS public.idx_memory_records_lifecycle;
DROP INDEX IF EXISTS public.idx_memory_records_hot;
ALTER TABLE public.memory_records
  DROP COLUMN IF EXISTS lifecycle_state, DROP COLUMN IF EXISTS relevance_score,
  DROP COLUMN IF EXISTS relevance_computed_at, DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS resurrected_count;
-- and re-CREATE OR REPLACE the 032 bodies of the search RPCs WITHOUT the archived guard.
```
System is byte-for-byte back to post-`032` behavior. **No source content is at risk** — the sweep only ever wrote metadata.

**Safety invariant to enforce in code review:** the lifecycle sweep must only `UPDATE` the new metadata columns (+ the Phase 14 merge columns, via the existing dedup contract) and `INSERT` into `memory_lifecycle_audit`. It must hold **no `DELETE`** on `memory_records` and **no write to `content`**. Any such write is a blocking defect — it is what guarantees Tiers 1–3 and the "content never destroyed" property.

---

## 10. Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Archive storage | **Same table, `lifecycle_state` flag** | Cold `memory_archive` table | No data movement; resurrection is a one-row UPDATE; FKs (`entity_mentions`, clusters 033, graph 034) stay valid. Cost: archived rows still sit in the ivfflat index → mitigated by partial hot index. |
| Lifecycle vs `active`/`expires_at` | **New `lifecycle_state` enum, orthogonal** | Overload `active`/`expires_at` | `active` is the user/abuse kill switch; `expires_at` is deterministic hard expiry. Conflating archival into either loses meaning and reversibility. Cost: one new column. |
| Relevance score | **Stored + recomputed by sweep** | Computed live per query | Live computation can't drive *transitions* (you need a persisted value to compare across sweeps) and would re-cost every query. Cost: a recompute job + staleness window. |
| Ranker integration | **Additive centered bump (`W_LIFE`), default 0** | Sixth weighted term in the `sum=1.0` | A weighted term forces re-tuning + re-benchmark of all five weights; the additive bump (like `temporalBoost`) ships neutral and is independently gated. Cost: slightly less "principled" than a pure weighted sum. |
| Reinforcement model | **Effective-age slide + saturating term** | Linear add to score | The slide directly realizes "each retrieval extends lifetime"; saturation + weight caps prevent junk runaway. Cost: two interacting knobs to reason about. |
| Decay half-life | **90d (longer than ranker's 30d recency)** | Match 30d | Retention should be more forgiving than per-query recency so important-old facts survive. Cost: junk lingers a bit longer (covered by importance/occurrence gates + archival grace). |
| Stale merge | **Reuse Phase 14 RPC + audit, cold-set only** | New merge subsystem | Don't reinvent dedup; same never-delete contract. Cost: only catches same-category cold dupes (consolidation 033 handles cross-category grouping). |
| Where it runs | **Async `memory_lifecycle` job + pg_cron** | Inline / DB trigger | LLM step + per-user batching must be async; triggers can't call LLMs in-txn. Honors worker invariants. Cost: eventual consistency (a memory may cool a sweep late). |
| Backfill | **Resumable job, not in migration** | Populate in the migration | Keeps `db reset` fast/deterministic; resumable under the 55s cron budget. Cost: a transient window where `relevance_score IS NULL` (treated as `active`). |

### Risks & mitigations

- **State flapping** (dormant↔active each sweep) → hysteresis gap `DORMANT_T 0.40` vs `REACTIVATE_T 0.55`; `ARCHIVE_GRACE_DAYS` before any archival.
- **Archiving something still wanted** → archived rows are resurrectable (§8) and exclusion is flag-reversible (Tier 1) with zero data loss; importance floor (0.85) never archives.
- **Runaway retention of junk** → reinforcement bounded by `REINF_CAP` + `W_REINF_L=0.25` cap; low-importance low-occurrence rows can't clear `DORMANT_T`.
- **Starving rare-but-important** → importance is the largest weight (0.30) and decay-independent (worked example §11).
- **Benchmark regression** → `W_LIFE` ships at 0; enabling it is benchmark-gated.
- **Orphaning a live cluster/graph node** → archival of a sole cluster anchor is deferred to `dormant` until re-consolidation; graph edges are signalled invalid, not silently stale.

---

## 11. Migration requirements (`035_memory_lifecycle.sql`)

- **Additive, idempotent.** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for the five columns (with a `CHECK (lifecycle_state IN ('active','dormant','archived','expired'))` added via a guarded `DO $$ … $$` or `ADD CONSTRAINT IF NOT EXISTS` pattern). `CREATE TABLE IF NOT EXISTS memory_lifecycle_audit` + RLS with `DROP POLICY IF EXISTS` guards. Indexes `IF NOT EXISTS`. References only existing objects → safe under strict-ordered `db reset`.
- **RPC bodies** updated via `CREATE OR REPLACE` (signatures/inputs unchanged → grants preserved) to add the `lifecycle_state <> 'archived'` predicate and **surface `relevance_score`** in the return shape. *Note:* adding an OUT column requires `DROP FUNCTION` + `CREATE` (as `032:18` did) — so surfacing `relevance_score` is a return-shape change handled the same way `032` handled it; the archived-exclusion predicate alone is a pure body change.
- **New service-role RPC** `resurrect_memories(p_user_id UUID, ids UUID[])` (mirrors `record_memory_retrievals`, `032:117-129`): `SECURITY DEFINER`, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT … TO service_role`.
- **No enum migration** for `job_type` — `memory_lifecycle` is free TEXT (`011:76`).
- **pg_cron schedule** added like `024–026`: schedule only if Vault `project_url` + `worker_secret` exist, else no-op (keeps `db reset` green); provisioned by `scripts/setup-worker.sql`.
- **Backfill (separate resumable job, not in the migration):** the migration leaves `relevance_score = NULL` / `lifecycle_state = 'active'` for existing rows (so behavior is unchanged immediately). A `memory_lifecycle` job with `scope:backfill` pages users in `(user_id, id)` order, computes initial relevance, sets initial state (`expires_at <= now()` → `expired` label; everything else `active`), chunked under `MAX_JOBS_PER_RUN`/55s, idempotent (re-running recomputes), gated behind `LIFECYCLE_SWEEP_ENABLED`.
- **CI:** `deno check` on the worker's new branch and the retrieve-context RPC callers; a `scripts/validate-*.sql` assertion that a sweep run leaves `memory_records` **row count and `content`** unchanged (the never-destroy invariant).

---

## 12. Testing strategy

Real automated tests are Deno (`deno test --allow-read --allow-net`) plus `db reset` validation SQL — there is no frontend runner (`CLAUDE.md`). Lifecycle is highly testable because decay/relevance are **pure functions of injected `nowMs`** (the ranker already takes `nowMs`, `ranker.ts:131-137`).

**Unit (deterministic, time-travel via injected `now`):**
- `relevance_score` component math: assert `decayFactor`, `reinforcementRetention`, `occurrenceFactor` at fixed ages/counts hit expected values (e.g. 90d untouched → `decayFactor ≈ 0.367`).
- **Reinforcement-vs-decay** cases: same `created_at`, vary `retrieval_count`/`last_retrieved_at`; assert the reinforced one stays `active` and the untouched one cools — the §11 worked numbers as golden assertions.
- **Importance floor:** importance 0.9 at 180d never archives.
- **Junk:** importance 0.1, occurrence 1, no retrievals at 200d → `archived`.
- **Transition rules:** table-driven over §6 — feed `(state, relevance, ageInState)` tuples, assert next state; explicitly assert hysteresis (0.45 relevance does *not* reactivate a dormant row).
- **Ranker bump:** `W_LIFE=0` produces identical `finalScore` to today (regression guard); `W_LIFE>0` nudges but never reorders a clear semantic winner (mirror `temporalBoost` tests).

**Integration (SQL, against `supabase start`):**
- **Retrieval exclusion:** seed an `archived` row; assert `hybrid_search_memories` excludes it and a non-archived twin returns; flip the exclusion flag → both return.
- **Idempotent sweep:** run the sweep twice with frozen time; second run produces **zero** transitions (only `recomputed` audit rows or none).
- **Resurrection:** archive a row; insert a near-duplicate via the extraction/dedup path; assert the canonical flips to `active`, `resurrected_count = 1`, an audit row exists, and **content is unchanged**.
- **Never-destroy:** `SELECT count(*), md5(string_agg(content, …))` before/after a full sweep are equal — the validation-SQL CI assertion.
- **Cluster/graph signalling (with 033/034 present):** archiving a non-anchor member prunes its `memory_cluster_members` row and enqueues re-consolidation; a sole active-cluster anchor is held at `dormant`.

**Rollback/flag tests:**
- With `LIFECYCLE_RETRIEVAL_EXCLUSION_ENABLED=off`, archived rows are retrievable (Tier 1 proof).
- Tier 2 reset UPDATE returns all rows to `active` and retrieval matches pre-lifecycle output.
- Down-migration (Tier 3) drops cleanly and `db reset` of the prior migration set stays green.

---

## Appendix — worked example: one memory through `active → dormant → archived → resurrected`

A medium-importance fact, `created_at` = day 0. `DECAY_HALFLIFE_DAYS=90`, weights `W_AGE 0.35 / W_IMP 0.30 / W_REINF_L 0.25 / W_OCC 0.10`. `importance = 0.5`, `occurrence_count = 1` (`occurrenceFactor = log1p(1)/log1p(10) ≈ 0.29`).

**Day 0 — `active`, just extracted, never retrieved.**
```
effectiveAgeDays = 0 → decayFactor = 1.0
reinforcementRetention = 0 (retrieval_count 0)
relevance = 0.35*1.0 + 0.30*0.5 + 0.25*0 + 0.10*0.29 ≈ 0.529   → active (≥ DORMANT_T 0.40)
```

**Day 120 — still never retrieved.**
```
effectiveAgeDays = 120 → decayFactor = exp(-120/90) ≈ 0.264
relevance = 0.35*0.264 + 0.30*0.5 + 0 + 0.10*0.29 ≈ 0.092+0.150+0.029 ≈ 0.271
0.271 < DORMANT_T (0.40)  → transition active → dormant   (audit: cooled)
```

**Day 135 — a query retrieves it (still retrievable while dormant).** `record_memory_retrievals` sets `retrieval_count=1`, `last_retrieved_at`=day 135. Sweep at day 136:
```
effectiveAgeDays = (136-135) = 1 → decayFactor = exp(-1/90) ≈ 0.989   (the slide!)
magnitude = log1p(1)/log1p(50) ≈ 0.176 ;  freshness = exp(-1/45) ≈ 0.978
reinforcementRetention ≈ 0.176*0.978 ≈ 0.172
relevance = 0.35*0.989 + 0.30*0.5 + 0.25*0.172 + 0.10*0.29
          ≈ 0.346 + 0.150 + 0.043 + 0.029 ≈ 0.568
0.568 ≥ REACTIVATE_T (0.55)  → dormant → active   (audit: reactivated)
```
*Reinforcement counteracted decay* — one retrieval reset the clock and pushed it back over the reactivation line.

**Day 135 → day 320 — never retrieved again.** At sweep day 320, `effectiveAgeDays = 320-135 = 185`:
```
decayFactor = exp(-185/90) ≈ 0.128
daysSinceLastRetrieval = 185 → freshness = exp(-185/45) ≈ 0.0164
reinforcementRetention ≈ 0.176*0.0164 ≈ 0.0029
relevance = 0.35*0.128 + 0.30*0.5 + 0.25*0.0029 + 0.10*0.29
          ≈ 0.045 + 0.150 + 0.0007 + 0.029 ≈ 0.225
```
`0.225` is below `DORMANT_T` but above `ARCHIVE_T (0.20)` → stays `dormant`. The reinforcement term has decayed away (freshness ≈ 0); importance (0.15 floor) is now what's holding it up.

**Day 400 — `effectiveAgeDays = 265`, has been dormant > `ARCHIVE_GRACE_DAYS`.**
```
decayFactor = exp(-265/90) ≈ 0.053
relevance ≈ 0.35*0.053 + 0.150 + ~0 + 0.029 ≈ 0.198 < ARCHIVE_T (0.20), importance 0.5 < 0.85
→ dormant → archived ; archived_at = day 400 ; cluster members pruned ; graph edges signalled
   (audit: archived).  Now EXCLUDED from retrieval (§5.2).
```

**Day 430 — new extraction produces a near-duplicate fact** whose nearest neighbor (`match_memory_candidates`) is this archived row at distance 0.11 (< `DEDUP_DISTANCE_THRESHOLD` 0.15). The dedup path **resurrects** rather than silently merging into a cold row:
```
lifecycle_state = 'active' ; archived_at = NULL ; resurrected_count = 1
Phase-14 merge bumps: occurrence_count = 2, confidence_score += 5, last_seen_at = day 430
memory_merge_audit row written (existing contract) + memory_lifecycle_audit (action=resurrected,
  trigger=new_evidence)
```
The fact became relevant again, is back in the hot set, and **its original `content` was never altered or deleted at any step** — every transition was metadata-only and audited, and the whole path is reversible via the flags/resets in §9.
