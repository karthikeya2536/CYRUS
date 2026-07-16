# Memory Consolidation System — Design Document

**Status:** Architecture only (no implementation)
**Date:** 2026-06-23
**Scope:** Cyrus V2 memory layer (`memory_records`, `entity_mentions`, `retrieve-context`, `llm-worker`)

---

## 1. Problem

Memories are stored as independent, atomic facts. For a single entity, the store
accumulates fragments:

```
[person]     Keerthana Rao is a collaborator
[commitment] Keerthana Rao signed the contract
[commitment] Keerthana Rao requested updates
[project]    Keerthana Rao works on xConnect
```

Each row is a separate `memory_records` entry keyed by
`(user_id, category, memory_key)` (`011_reconstruct_schema.sql:30-56`). Retrieval
fetches them **independently** through `hybrid_search_memories`
(`032_retrieval_ranking_signals.sql:19-57`), ranks each in isolation
(`ranker.ts:54-58`), and the assembler emits one context line per row
(`assembler.ts`). The query *"what's going on with Keerthana?"* therefore:

- spends 4 context slots on 4 fragments that are really **one subject**,
- competes those fragments against each other for the token budget (~2000 words),
- gives the LLM a scattered, de-correlated picture instead of a profile,
- and the existing graph hop (`graph_expand_memories`) **navigates** between them
  at query time but never **groups** them — there is no persistent structure
  (confirmed: no cluster/group/thread table exists today).

**Consolidation** adds a layer that recognizes these four rows describe one entity,
groups them, and at retrieval substitutes a single **rich context object** for the
scattered members — while leaving every original `memory_records` row untouched.

### Design constraints (from the codebase)

- `CLAUDE.md`: *avoid schema changes unless the task requires one; prefer logic over
  new columns/tables.* Consolidation genuinely requires persistent grouping, so new
  **tables** are justified — but we add **zero columns to `memory_records`** and keep
  the layer fully derivable/droppable.
- Migrations must be idempotent (`IF NOT EXISTS`, policy drop-guards); CI runs a clean
  `supabase db reset`.
- RLS everywhere (`auth.uid() = user_id`); edge functions use service-role and must
  filter `user_id` explicitly.
- Long/LLM work is **never inline** — it goes through `llm_jobs` + `llm-worker`
  (reclaim → claim → retry → dead-letter invariants).
- Embeddings are `vector(768)` (resolved by OmniRoute via `OMNIROUTE_EMBEDDING_MODEL`).

---

## 2. Core principle: consolidation is a *derived, additive* layer

```
                         ┌─────────────────────────────────────────┐
   SOURCE OF TRUTH  ───► │  memory_records  (UNCHANGED, append-only │
   (never mutated)       │  facts; dedup via occurrence_count)      │
                         └───────────────┬─────────────────────────┘
                                         │  entity_mentions (existing graph edges)
                                         ▼
                         ┌─────────────────────────────────────────┐
   DERIVED LAYER    ───► │  memory_clusters        (groups)         │
   (rebuildable,         │  memory_cluster_members (M:N join)       │
    droppable)           │  memory_cluster_audit   (every action)   │
                         └───────────────┬─────────────────────────┘
                                         ▼
                         ┌─────────────────────────────────────────┐
   QUERY TIME       ───► │ retrieve-context: member→cluster collapse│
                         │ → one rich context object per subject    │
                         └─────────────────────────────────────────┘
```

The invariant that makes everything else safe: **a cluster is a function of
`memory_records` + `entity_mentions`.** It is always reconstructable. Dropping the
three new tables returns the system to today's exact behavior. This is what makes
rollback trivial (§7) and migration low-risk (§8).

---

## 3. Storage model

Three new tables. No changes to `memory_records`, `entity_mentions`, or `llm_jobs`
schema (the new job type is a TEXT value, not an enum, so no migration needed there).

### 3.1 `memory_clusters` — the group + its rich context object

| column | type | purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS / tenant isolation |
| `cluster_key` | TEXT NOT NULL | normalized canonical anchor (e.g. `entity:keerthana rao`). Stable identity for incremental updates; basis of a UNIQUE `(user_id, cluster_key)` so re-consolidation upserts instead of duplicating |
| `anchor_type` | TEXT | `entity` \| `topic` \| `thread` — what the cluster is organized around (v1: `entity` only) |
| `label` | TEXT | human-readable name ("Keerthana Rao") |
| `summary` | TEXT | **the rich context object** — LLM-generated synthesis of all members ("Keerthana Rao is a collaborator on xConnect who signed the contract and is awaiting updates.") |
| `facets` | JSONB | structured roll-up by category, e.g. `{"role":[...],"commitments":[...],"deadlines":[...]}` — deterministic, LLM-free fallback when summary generation is unavailable |
| `centroid` | vector(768) | mean (or medoid) of member embeddings — lets a cluster be retrieved **directly**, not only via its members |
| `member_count` | INTEGER | denormalized count for ranking/observability |
| `importance` | DOUBLE PRECISION | `max(member.llm_importance, member.system_importance)` rolled up |
| `earliest_deadline_at` | TIMESTAMPTZ | `min(member.deadline_at)` — drives urgency scoring for the whole cluster |
| `summary_model` | TEXT | provider that wrote `summary` (or `rule-engine`) — mirrors `llm_provider` convention |
| `version` | INTEGER DEFAULT 1 | bumped on each materialization; enables optimistic concurrency + targeted rollback |
| `active` | BOOLEAN DEFAULT TRUE | soft-delete, mirrors `memory_records.active` |
| `last_consolidated_at` | TIMESTAMPTZ | staleness signal for the scheduler |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Indexes:** UNIQUE `(user_id, cluster_key)`; ivfflat on `centroid` (cosine, lists=100,
mirrors `idx_memory_records_embedding`); btree `(user_id, active)`.

### 3.2 `memory_cluster_members` — M:N membership

| column | type | purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `cluster_id` | UUID FK → memory_clusters ON DELETE CASCADE | |
| `memory_id` | UUID FK → memory_records ON DELETE CASCADE | **member rows are never copied** — only referenced |
| `membership_score` | DOUBLE PRECISION | confidence this memory belongs (centroid distance / adjudication score) |
| `added_by` | TEXT | `entity-rule` \| `semantic` \| `llm` \| `manual` — provenance |
| `added_at` | TIMESTAMPTZ DEFAULT now() | |

**Constraint:** UNIQUE `(cluster_id, memory_id)`.
**Why M:N (not a `cluster_id` column on `memory_records`):**

1. Honors "no `memory_records` schema change" and "preserve originals."
2. A memory mentioning two entities ("Keerthana signed the xConnect contract")
   legitimately belongs to both the *Keerthana* and *xConnect* clusters — a single FK
   can't express that, and forcing a choice loses graph edges.
3. `ON DELETE CASCADE` from `memory_records` means expiry/soft-delete of a fact
   auto-prunes its membership; the cluster self-heals on next consolidation.

**Indexes:** `(memory_id)` (the hot path — "which clusters does this matched memory
belong to?"); `(cluster_id)`.

### 3.3 `memory_cluster_audit` — append-only action log

Mirrors `memory_merge_audit` (`018_memory_dedup.sql:52-72`). Every consolidation
action writes a row: `created` | `member_added` | `member_removed` | `summary_updated`
| `split` | `deactivated`. Columns: `cluster_id`, `memory_id` (nullable),
`action`, `reason`, `adjudicator` (provider), `prev_version`, `new_version`,
`detail` JSONB, `created_at`. This is the **undo log** (§7) and the observability
surface. Append-only; users read their own.

### What we deliberately do **not** store

- No copy of member content inside the cluster (originals stay sovereign; summary is
  derived and regenerable).
- No new columns on `memory_records` (no `cluster_id`, no `consolidated` flag) — keeps
  the source table clean and the layer droppable.

---

## 4. Retrieval model

Goal: requirement 3 ("prevent duplicate retrieval") and 4 ("richer context objects"),
without rewriting the ranker.

### 4.1 The collapse step (the heart of it)

Today's flow (`retrieve-context/index.ts:134-207`):

```
hybrid_search_* ─► ranker.ts (score each) ─► graph_expand ─► assembler (1 line/row)
```

New flow inserts **one collapse stage** between candidate fetch and assembly:

```
hybrid_search_memories ─► [collapse] ─► ranker.ts ─► assembler
        +                     │
hybrid_search_clusters ───────┘
```

1. **Fetch as today** plus a new `hybrid_search_clusters` RPC (centroid vector search,
   same shape/filters as `hybrid_search_memories`, returns cluster rows with `summary`,
   `facets`, `importance`, `earliest_deadline_at`).
2. **Map matched memories → clusters** via `memory_cluster_members` (single indexed
   lookup on `memory_id`).
3. **Collapse:** if ≥ `COLLAPSE_MIN` (default 2) matched memories share a cluster,
   **drop those member rows** from the candidate set and **inject the cluster object**
   in their place. A lone matched member (count 1) passes through unchanged — a single
   fact does not need a profile wrapper.
4. **Carry the best member score** onto the cluster so ranking stays comparable:
   `cluster.semantic = max(member.semantic for collapsed members)`. The cluster then
   competes in `ranker.ts` as a single item, using its rolled-up `importance` and
   `earliest_deadline_at` for the urgency/importance signals already defined
   (`ranker.ts:54-58`). No weight retuning required.

### 4.2 Ranker & assembler changes (minimal)

- **Ranker:** treat a cluster as a normal ranked item. It already keys off
  `hybrid_score`, `importance`, `deadline_at`, `recency` — the cluster supplies all
  four. Add a small `W_CLUSTER` cohesion nudge (optional) so a dense, high-member-count
  cluster edges out a single loose fact; default 0 to ship neutral.
- **Assembler** (`assembler.ts`): one new format branch:
  `[Profile - {label}] {summary}` (or the deterministic `facets` roll-up if no summary).
  Crucially this **shrinks** token usage — 1 synthesized object replaces N lines — so
  more *distinct subjects* fit under the ~2000-word cap. Existing source_hash/text
  dedup is unaffected (clusters carry a synthetic hash).

### 4.3 Graph retrieval (requirement 6)

Clusters are a **superset** of the entity graph, so they compose cleanly:

- Seeds for `graph_expand_memories` can now be **cluster members** (broader, better
  seeds) — or, in a later phase, a `graph_expand_clusters` that hops cluster→cluster
  along shared entities, giving a coarse "who/what is connected to Keerthana" map at a
  fraction of the row count.
- `cluster_key = entity:<name>` makes the cluster table a natural materialization of the
  entity graph's nodes — future graph work reads structure that already exists instead
  of recomputing recursive CTEs per query.

### 4.4 Why this prevents duplicate retrieval

The duplication today is **semantic**, not byte-level: four rows about one person.
`assembler.ts` dedup only catches identical hashes/prefixes. Collapse operates at the
**subject** level — the unit of de-duplication becomes the cluster, so the four
Keerthana fragments can never again occupy four slots.

---

## 5. Consolidation triggers

Three triggers, all routed through the existing async job system. **New job type:**
`memory_consolidation` (TEXT payload `{ user_id, cluster_key? , scope }`). No enum
migration — `job_type` is free TEXT (`011_reconstruct_schema.sql:73-99`). `llm-worker`
gains one dispatch branch; reclaim/claim/retry/dead-letter invariants are untouched.

| # | Trigger | When | Scope | Producer |
|---|---|---|---|---|
| 1 | **Incremental (event-driven)** | A `memory_extraction` job inserts/merges a memory and writes `entity_mentions` (`llm-worker:455-461`) | Enqueue a `memory_consolidation` job scoped to each affected `entity:<name>` | `llm-worker`, at the tail of `processMemoryExtraction` |
| 2 | **Scheduled (sweep)** | pg_cron, low frequency (e.g. every 30 min), mirrors the `llm-worker-drain` pattern (`022_schedule_llm_worker.sql`) | Re-consolidate clusters where `last_consolidated_at` is stale or `member_count` drifted from live counts | pg_cron → enqueues a `scope:sweep` job |
| 3 | **Threshold (lazy)** | At incremental time, only materialize a cluster once an entity has ≥ `CLUSTER_MIN_MEMBERS` (default 2–3) facts | Avoids singleton clusters; an entity with one fact stays a plain memory until it earns a group | inside the consolidation handler |

**Why job-based and not inline / not a DB trigger:**

- Consolidation calls the LLM (summary generation, ambiguous-merge adjudication) →
  must be async per the central pattern.
- A Postgres trigger on `memory_records` insert would run LLM work in a transaction —
  forbidden. Enqueuing a job is the only sanctioned path.
- Idempotency: jobs are keyed by `cluster_key`; a pending/processing job for the same
  key short-circuits (same guard `memory-extraction` already uses, `index.ts:52-79`).

### Handler outline (no code)

```
claim memory_consolidation job
 └─ for each affected cluster_key:
     1. gather candidate memories  (entity_mentions match + active + not expired)
     2. if count < CLUSTER_MIN_MEMBERS → skip (lazy threshold)
     3. compute centroid; group members (see §6 thresholds)
     4. upsert memory_clusters by (user_id, cluster_key); bump version
     5. reconcile memory_cluster_members (add new, remove pruned)
     6. regenerate summary via LLMRouter; fall back to deterministic facets
        roll-up if router returns the rule-engine sentinel
     7. write memory_cluster_audit row(s)
```

Steps 1–5 are deterministic and cheap; only step 6 touches the LLM, and it degrades
gracefully (the `ruleBasedBriefing`/`ruleBasedExtraction` precedent).

---

## 6. Merge thresholds

Consolidation **groups related** facts; dedup (Phase 14) **collapses identical** facts.
They must not be confused, so consolidation thresholds are deliberately **looser** than
`DEDUP_DISTANCE_THRESHOLD` (0.15) and gated by a hard structural signal.

### Two-gate model

A candidate memory joins a cluster only if **Gate A AND (Gate B or Gate C)**:

- **Gate A — structural (required):** shares an `entity_mention` with the cluster's
  anchor (case-insensitive, the existing graph predicate). This prevents
  semantically-adjacent-but-unrelated facts ("signed a contract" about two different
  people) from merging. Entities are the spine.
- **Gate B — semantic:** centroid cosine distance ≤ `CONSOLIDATE_DISTANCE_THRESHOLD`
  (default **0.30**, env-tunable like the dedup knob). Looser than dedup because we
  *want* related-not-identical facts.
- **Gate C — adjudicated:** if distance is in the ambiguous band
  (`0.30 < d ≤ 0.45`), defer to one LLM adjudication call
  (reuse the `MEMORY_DEDUP_SYSTEM`-style pattern with a "same subject?" prompt). On
  router failure → conservative default = **do not merge** (keep facts separate; a
  missed grouping is cheaper than a wrong one).

### Cluster-level guards

| knob | default | meaning |
|---|---|---|
| `CLUSTER_MIN_MEMBERS` | 2 | below this, no cluster is materialized |
| `CLUSTER_MAX_MEMBERS` | 50 | above this, split (see below) — keeps summaries coherent and centroids meaningful |
| `COLLAPSE_MIN` | 2 | retrieval collapses only when ≥ N members matched |
| `CONSOLIDATE_DISTANCE_THRESHOLD` | 0.30 | Gate B |
| `ADJUDICATION_BAND` | (0.30, 0.45] | Gate C |

**Splitting:** when a cluster exceeds `CLUSTER_MAX_MEMBERS` or its members form two
clearly separated centroids (intra-cluster distance bimodal), the handler may split
into sub-clusters (`cluster_key = entity:keerthana rao#2`) and log a `split` audit
action. v1 can defer splitting and simply cap membership, logging the overflow.

**Category interplay:** unlike dedup (same-category only, a hard guard in
`match_memory_candidates`), consolidation is intentionally **cross-category** — the
point is to unite `person` + `commitment` + `project` facts about one entity. The
`facets` JSONB preserves category structure inside the group.

---

## 7. Rollback strategy

Three tiers, from cheapest to most surgical. All possible because the layer is derived
(§2).

### Tier 1 — Feature flag (instant, no data change)

A single env flag read by `retrieve-context` (e.g. `CONSOLIDATION_ENABLED`). When off,
the collapse stage (§4.1) is skipped and retrieval behaves **exactly** as today —
clusters are ignored, members flow through individually. This is the first lever for
any regression; no migration, no deploy of the worker, instant via
`supabase secrets set`. Writers (the consolidation job) can be independently disabled by
a second flag so we can stop *building* clusters while still *reading* them, or vice
versa.

### Tier 2 — Drop the layer (full reversal)

Because clusters are a pure function of `memory_records` + `entity_mentions`:

- `TRUNCATE`/drop the three tables (a down-migration), and the system is byte-for-byte
  back to pre-consolidation behavior. **No source data is at risk** — we never mutated
  `memory_records`.
- Rebuild is a single backfill job (§8) — drop-and-rebuild is a supported, idempotent
  operation, not a disaster recovery.

### Tier 3 — Surgical undo (per-cluster / per-action)

`memory_cluster_audit` + `version` make targeted reversal possible:

- Bad summary on cluster X → regenerate, or revert `summary` from the prior audit
  `detail` snapshot.
- Wrong merge (Gate C false-positive) → `member_removed` action; the freed memory
  reverts to standalone retrieval immediately (it was never altered).
- A whole consolidation run gone wrong → replay the audit log for that
  `last_consolidated_at` window and deactivate affected clusters.

**Safety invariant to preserve in implementation:** the consolidation worker must only
ever `INSERT`/`UPDATE` the three new tables. It must hold **no write path** to
`memory_records` or `entity_mentions`. Code review should treat any such write as a
blocking defect — it is what guarantees Tiers 1–2.

---

## 8. Migration requirements

### Schema (one new migration, e.g. `033_memory_consolidation.sql`)

- Create `memory_clusters`, `memory_cluster_members`, `memory_cluster_audit` with
  `CREATE TABLE IF NOT EXISTS`.
- Enable RLS + per-user policies (`auth.uid() = user_id`) with `DROP POLICY IF EXISTS`
  guards (idempotent, CI-`db reset`-safe). Audit + members readable by owner; writes
  are service-role only (consolidation runs as `supabaseAdmin`).
- Indexes per §3 (`IF NOT EXISTS`). The ivfflat on `centroid` must follow the existing
  `vector(768)` + `vector_cosine_ops` + `lists=100` convention.
- New RPCs (SECURITY DEFINER, granted per existing pattern):
  - `hybrid_search_clusters(query_text, query_embedding, match_count)` →
    cluster rows (modeled on `hybrid_search_memories`, includes `expires`-style guard
    via `active` + `earliest_deadline_at`).
  - `cluster_members_for_memories(p_user_id, memory_ids[])` → the collapse lookup,
    one round-trip instead of N.
  - `record_cluster_retrievals(p_user_id, cluster_ids[])` — optional, mirrors
    `record_memory_retrievals` for cluster-level reinforcement.
  - (later) `graph_expand_clusters(...)`.

### No-change commitments (de-risking)

- **Zero** ALTERs to `memory_records`, `entity_mentions`, `llm_jobs`. The directive to
  avoid schema churn is honored at the source-of-truth level; new structure is isolated
  in additive tables.
- `job_type` stays free TEXT → no enum/constraint migration to add
  `memory_consolidation`.

### Backfill (one-time, job-based — not in the migration)

The migration creates **empty** tables (keeps `db reset` fast and deterministic).
Population is a separate, resumable operation:

- A `memory_consolidation` job with `scope:backfill` that pages over existing users'
  `entity_mentions`, groups by entity, and materializes clusters in batches
  (respect `MAX_JOBS_PER_RUN`, chunk per user to stay within the worker's per-run
  budget and the 55s cron timeout).
- Idempotent: keyed by `(user_id, cluster_key)` upsert, so re-running is safe and a
  partial backfill simply resumes.
- Gated behind the writer feature flag so backfill can be paused.

### Ordering / CI

- The migration is purely additive and references only existing objects → safe under
  strict ordered `db reset`.
- `deno check` must pass for the new `retrieve-context` collapse code and the worker's
  new dispatch branch (CI gate).
- A `scripts/validate-*.sql` assertion can verify the rollback invariant indirectly:
  e.g. row counts in `memory_records` are unchanged by a consolidation run.

---

## 9. Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Grouping representation | **Separate tables (derived layer)** | `cluster_id` column on `memory_records` | Preserves originals, honors no-schema-churn directive, M:N membership, trivially droppable. Cost: an extra join at retrieval. |
| Membership cardinality | **Many-to-many** | One cluster per memory | A fact can mention multiple entities; 1:1 destroys graph edges. Cost: collapse logic must handle a memory in >1 matched cluster (pick highest-ranked, log the rest). |
| Where consolidation runs | **Async `llm_jobs` worker** | Inline at extraction / DB trigger | LLM work must be async; triggers can't call LLMs in-txn. Cost: clusters are eventually-consistent (seconds–minutes lag) — acceptable for a "second brain." |
| Anchor for v1 | **Entity-based** (`entity_mentions`) | Topic/semantic clustering | Entities are already extracted and indexed; a hard structural gate prevents bad merges. Cost: facts with no proper-noun entity won't cluster yet (topic anchors are a later phase). |
| Summary generation | **LLM with deterministic `facets` fallback** | Always-LLM, or never-LLM | Rich object when providers are up; graceful degradation matches the `rule-engine` precedent. Cost: summary can be stale until re-consolidation. |
| Retrieval integration | **Collapse stage + cluster centroid search** | Replace per-memory retrieval entirely | Additive; ranker/weights largely unchanged; flag-reversible. Cost: two retrieval sources to keep coherent. |
| Merge strictness | **Entity gate + loose semantic + LLM tiebreak** | Pure vector threshold | Avoids "wrong-subject" merges that pure distance causes. Cost: an extra LLM call in the ambiguous band. |
| Eventual consistency | **Accepted** | Strong consistency (sync) | Keeps the request path fast and the worker invariants intact. Cost: a just-created fact may retrieve standalone until its consolidation job runs. |

### Risks & mitigations

- **Over-merging** (two people, same first name) → entity gate is case-insensitive
  string match, so "Keerthana Rao" ≠ "Keerthana Singh"; ambiguous band escalates to
  LLM; conservative default is *don't merge*.
- **Stale summaries** after new facts arrive → incremental trigger re-consolidates the
  touched cluster; scheduled sweep catches drift.
- **Centroid drift** as clusters grow → `CLUSTER_MAX_MEMBERS` + split keep centroids
  representative.
- **Retrieval latency** from the extra join/RPC → `cluster_members_for_memories` is a
  single indexed batch lookup; cluster centroid search reuses the ivfflat index pattern.
- **Cost** of summary LLM calls → only on materialization/change, not per query; rule
  fallback caps spend.

---

## 10. Implementation phases

Each phase is independently shippable and flag-guarded; nothing changes user-visible
behavior until Phase 4 flips the read flag.

**Phase 0 — Schema & invariants (no behavior change).**
Migration `033`: three tables, RLS, indexes, empty. Add `CONSOLIDATION_ENABLED` /
`CONSOLIDATION_WRITE_ENABLED` flags (default off). Validation SQL asserting additive-only.
*Exit:* `db reset` green, `deno check` green.

**Phase 1 — Consolidation worker (write path, dark).**
New `memory_consolidation` job type + `llm-worker` dispatch branch; deterministic
grouping (Gates A/B), centroid computation, member reconciliation, audit writes.
Summary = deterministic `facets` only (no LLM yet). Incremental trigger enqueues jobs.
Flag-gated so it can run in production silently and be inspected via the audit table.
*Exit:* clusters materialize correctly for new memories; `memory_records` provably
unchanged.

**Phase 2 — LLM summaries + adjudication (Gate C).**
Add summary generation via `LLMRouter` with rule fallback; ambiguous-band adjudication.
*Exit:* clusters carry rich `summary`; adjudication decisions logged.

**Phase 3 — Backfill.**
`scope:backfill` job paging existing `entity_mentions` per user, idempotent upserts,
chunked to the worker budget. Run for a cohort first.
*Exit:* existing users have clusters; re-run is a no-op.

**Phase 4 — Retrieval collapse (read path on).**
`hybrid_search_clusters` RPC + `cluster_members_for_memories`; collapse stage in
`retrieve-context`; assembler `[Profile - …]` branch; ranker treats clusters as items.
Flip `CONSOLIDATION_ENABLED`. Watch `retrieval_runs` latency + quality.
*Exit:* the Keerthana query returns one profile object; token budget frees up.

**Phase 5 — Scheduled sweep + reinforcement.**
pg_cron re-consolidation (provisioned like `setup-worker.sql`); optional
`record_cluster_retrievals`; staleness-driven refresh.
*Exit:* clusters self-maintain.

**Phase 6 (future) — Graph-native retrieval.**
`graph_expand_clusters` (cluster→cluster hops via shared entities); `topic` anchors;
cluster splitting. Builds directly on the materialized graph nodes from Phase 1.

---

## Appendix — worked example

Input facts (existing `memory_records`, all retained):

```
m1 [person]     Keerthana Rao is a collaborator              entity_mentions: Keerthana Rao
m2 [commitment] Keerthana Rao signed the contract            entity_mentions: Keerthana Rao
m3 [commitment] Keerthana Rao requested updates              entity_mentions: Keerthana Rao
m4 [project]    Keerthana Rao works on xConnect              entity_mentions: Keerthana Rao, xConnect
```

After consolidation (`cluster_key = entity:keerthana rao`, members m1–m4; m4 also a
member of `entity:xconnect`):

```
memory_clusters:
  label   = "Keerthana Rao"
  summary = "Keerthana Rao is a collaborator on xConnect. She signed the contract
             and has requested updates."
  facets  = { role:["collaborator"], commitments:["signed contract","requested updates"],
              projects:["xConnect"] }
  centroid = mean(embedding(m1..m4))
  member_count = 4, earliest_deadline_at = min(deadlines)
```

Query *"what's happening with Keerthana?"*:

- before: 4 ranked rows, 4 context lines, competing for budget.
- after: members collapse → **1** `[Profile - Keerthana Rao]` object carrying the
  synthesized summary, ranked once, freeing 3 slots for other subjects.

`m1..m4` remain queryable individually; the cluster is droppable and rebuildable at any
time.
