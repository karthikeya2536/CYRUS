# Personal Knowledge Engine — Design Document

**Status:** Architecture only (no implementation)
**Date:** 2026-06-23
**Scope:** Cyrus V2 derived-fact layer, inference pipeline, state/dependency/goal tracking, contradiction detection, confidence propagation

---

## 1. Problem

Today, `memory_records` (`011_reconstruct_schema.sql:30-56`) stores **atomic facts**.
Three separate rows can describe the same real-world situation:

```
m1 [commitment] Contract signed
m2 [commitment] Follow-up pending
m3 [email]      Versant email missing
```

A human reading these together understands: *"Project onboarding is blocked because the
Versant email hasn't arrived."* But Cyrus has no mechanism to **derive** that synthesis
— no inference, no composition of facts, no recognition that three independently-stored
rows describe one blockage.

The existing system can:

- extract and dedup atomic facts (`memory-extraction` → `llm-worker`)
- retrieve them with hybrid search + graph expansion (`retrieve-context/`)
- rank and assemble them into a context bundle (`ranker.ts`, `assembler.ts`)
- group them by entity via consolidation (`memory_clusters`, design 033)

What's missing: a layer that **reasons over** memories + graph edges to produce
**derived facts** — compound insights with traceable provenance, confidence, and
structured enough for downstream systems (briefing intelligence, retrieval) to consume
deterministically.

### Core example

| Input | Derived fact |
|---|---|
| m1: "Contract signed" (commitment) | — |
| m2: "Follow-up pending" (commitment) | — |
| m3: "Versant email missing" (email) | — |
| Graph edge: Project:onboarding `depends_on` Task:versant-followup | — |
| Graph edge: Task:versant-followup `requires` Email:versant-outreach | — |
| → **Engine inference** | **"Project onboarding is blocked by missing Versant email"** |
| Evidence | `{ source_memories: [m1,m2,m3], graph_edges: [e1,e2], rule: "transitive_dependency_blocked" }` |
| Confidence | 0.78 (m3 confidence × edge validity × rule multiplier) |

### Design constraints (from the codebase)

- `CLAUDE.md`: *avoid schema changes unless required; prefer logic over new columns/tables.*
  The engine genuinely requires persistent derived-fact storage — additive tables justified;
  **zero** columns added to `memory_records`.
- Migrations idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`).
  CI runs clean `supabase db reset`.
- Long/LLM work is **never inline** — runs through `llm_jobs` + `llm-worker`
  (`022_schedule_llm_worker.sql`) with the reclaim → claim → retry → dead-letter invariants.
- RLS everywhere (`auth.uid() = user_id`); edge functions use service-role (`supabaseAdmin`)
  and must filter `user_id` explicitly.
- `LLMRouter.execute()` (`_shared/llm-router.ts`): uses OmniRoute as the sole AI gateway,
  eliminating provider-specific logic and model selection.
- Embeddings `vector(768)` via OmniRoute embedding model.

### Adjacent designs consumed (cross-reference by filename)

- **Memory Consolidation** (`033`, `2026-06-23-memory-consolidation-design.md`):
  entity-anchored `memory_clusters` with profiles + faceted roll-ups. Derived facts
  attach to cluster entities.
- **Knowledge Graph** (`034`, `2026-06-23-knowledge-graph-retrieval-design.md`):
  typed nodes/edges with multi-hop traversal. **The engine's primary input** —
  inferences are triggered by new edges and traverse typed paths.
- **Memory Lifecycle** (`035`, `2026-06-23-memory-lifecycle-design.md`):
  decay/relevance/archival — derived fact confidence decays with its source memories.
- **Autonomous Briefing Intelligence** (`037`): **the primary consumer** — reads
  derived facts, states, blockers, and contradictions for the daily briefing.

---

## 2. Architecture overview

```
                         ┌─────────────────────────────────────────┐
   SOURCE LAYERS    ───► │  memory_records  (011)                   │
   (never mutated)       │  entity_mentions  (021)                  │
                         │  memory_clusters  (033)                  │
                         │  graph_nodes/edges (034)                │
                         └───────────────┬─────────────────────────┘
                                         │ new graph edge inserted
                                         │ or memory created/updated
                                         ▼
                         ┌─────────────────────────────────────────┐
   INFERENCE ENGINE ──►  │  knowledge_inference job (new job_type)  │
   (async, via           │  ┌────────────────────────────────────┐ │
    llm-worker,         │  │ Stage 1: GATHER subgraph            │ │
    flag-gated)          │  │ Stage 2: RULE-BASED derivations     │ │
                         │  │ Stage 3: LLM-BASED derivations      │ │
                         │  │ Stage 4: CONTRADICTION check        │ │
                         │  │ Stage 5: CONFIDENCE scoring         │ │
                         │  │ Stage 6: UPSERT derived_facts       │ │
                         │  └────────────────────────────────────┘ │
                         └───────────────┬─────────────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────────────┐
   DERIVED STORE    ──►  │  derived_facts                          │
   (rebuildable,         │  fact_evidence  (provenance M:N)         │
    droppable)           │  subject_state   (per-entity state m/c)  │
                         │  trackables      (goals, projects)       │
                         │  dependencies     (between trackables)   │
                         │  contradictions   (conflicting facts)    │
                         │  inference_audit  (append-only log)      │
                         └───────────────┬─────────────────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────────────────┐
   CONSUMERS         ──► │  retrieve-context  (ranker + assembler)  │
                         │  generate-briefing  (briefing intel 037) │
                         └─────────────────────────────────────────┘
```

**Core invariant** (mirrors consolidation §2): the derived store is a pure function of
`memory_records` + `entity_mentions` + graph nodes/edges. It is always reconstructable
from a backfill sweep. Dropping the five new tables returns the system to exact
pre-engine behavior. **The inference engine has NO write path to `memory_records`,
`entity_mentions`, `graph_nodes`, or `graph_edges`** — it only writes its own derived
tables. This is a blocking code-review invariant.

---

## 3. Data structures

### 3.1 `derived_facts` — the core artifact

A derived fact is a statement **inferred** from ≥1 source memory and/or graph edge.
It is never a raw memory; it is always compound.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS / tenant isolation |
| `fact_key` | TEXT NOT NULL | normalized stable key (hash of statement + subject + fact_type); UNIQUE `(user_id, fact_key)` → upsert idempotent |
| `statement` | TEXT NOT NULL | natural-language assertion ("Project onboarding is blocked by missing Versant email") |
| `fact_type` | TEXT NOT NULL | `blocker` \| `status` \| `dependency` \| `trend` \| `contradiction` \| `opportunity` \| `risk` \| `relationship` — extensible free TEXT |
| `subject_type` | TEXT NOT NULL | `entity` \| `project` \| `goal` \| `memory_group` — what the fact is ABOUT |
| `subject_id` | TEXT NOT NULL | identifier for the subject — entity name, project key, goal key, etc. |
| `confidence` | DOUBLE PRECISION NOT NULL DEFAULT 0 | 0-1, propagated from source evidence (§8) |
| `severity` | DOUBLE PRECISION | 0-1, how consequential (for blocker/risk types — derived from deadlines, dependencies, graph position) |
| `derivation_rule` | TEXT | named rule that produced this fact (e.g. `transitive_dependency_blocked`, `inferred_status_from_edges`, `llm_inference`) |
| `derived_by` | TEXT | `omniroute` — indicates the LLM used via OmniRoute abstraction |
| `evidence_hash` | TEXT | hash of `(source_memory_ids + source_edge_ids + version)` for fast staleness check |
| `valid_from` | TIMESTAMPTZ | when the fact became true |
| `valid_until` | TIMESTAMPTZ | NULL if currently true; set when superseded/refuted |
| `version` | INTEGER DEFAULT 1 | bumped on re-derivation |
| `active` | BOOLEAN DEFAULT TRUE | soft-delete; set false when all sources expired or fact refuted |
| `embedding` | vector(768) | embedding of `statement`, for semantic retrieval |
| `retrieval_count` | INTEGER DEFAULT 0 | mirror of memory_records — reinforcement from retrieval |
| `last_retrieved_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |
| `last_inferred_at` | TIMESTAMPTZ DEFAULT now() | last re-derivation time |

**Indexes:** UNIQUE `(user_id, fact_key)`; ivfflat on `embedding` (cosine, lists=100,
`IF NOT EXISTS`); btree `(user_id, subject_type, subject_id)` — the hot path for
"what derived facts exist about this subject?"; `(user_id, fact_type, active)`.

### 3.2 `fact_evidence` — provenance M:N

Every derived fact traces to its sources. This is mandatory — no fact exists without
a provenance chain.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `fact_id` | UUID FK → derived_facts ON DELETE CASCADE | |
| `source_memory_id` | UUID FK → memory_records | NULL if evidence is purely graph-based |
| `source_edge_id` | UUID FK → graph_edges (from design 034) | NULL if evidence is purely memory-based |
| `evidence_role` | TEXT | `primary` \| `supporting` \| `context` — weight in confidence calc |
| `added_at` | TIMESTAMPTZ DEFAULT now() | |

**Constraint:** At least one of `source_memory_id` or `source_edge_id` must be non-null.
**Index:** `(fact_id)`; `(source_memory_id)` — enables fast staleness detection when a
source memory expires/deactivates.

### 3.3 `subject_state` — per-subject state machines

Tracks the *current state* of any named subject (entity, project, goal) as a derived
summary of related facts and graph edges.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `subject_type` | TEXT NOT NULL | `project` \| `goal` \| `entity` \| `initiative` |
| `subject_key` | TEXT NOT NULL | stable identifier (entity name, project key, goal key); UNIQUE `(user_id, subject_type, subject_key)` |
| `state` | TEXT NOT NULL | current state in the state machine (e.g. `active`, `blocked`, `at_risk`, `completed`, `stalled`, `unknown`) |
| `health` | DOUBLE PRECISION | 0-1 aggregate of sub-components (more blocked → lower) |
| `state_since` | TIMESTAMPTZ | when the current state was entered |
| `derived_from_facts` | UUID[] | array of fact IDs backing this state |
| `derived_from_edges` | UUID[] | array of graph edge IDs |
| `summary` | TEXT | LLM-generated one-sentence synthesis of state + why |
| `version` | INTEGER DEFAULT 1 | |
| `updated_at` | TIMESTAMPTZ DEFAULT now() | |

**State machines (v1):**

| Subject type | States | Transitions driven by |
|---|---|---|
| `project` | `not_started` → `onboarding` → `active` → `blocked` → `at_risk` → `completed` → `abandoned` | Task completion, blocker detection, deadline proximity |
| `goal` | `defined` → `in_progress` → `stalled` → `achieved` → `abandoned` | Milestone hits, dependency chains, contradictory evidence |
| `entity` | `active` → `dormant` → `archived` | Graph edge activity, memory lifecycle state of associated facts |

### 3.4 `trackables` — goals, projects, and initiatives

A lightweight registry of things the user cares about. Distilled from explicit
memories + inferred from activity patterns.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `trackable_key` | TEXT NOT NULL | UNIQUE `(user_id, trackable_key)` |
| `trackable_type` | TEXT NOT NULL | `project` \| `goal` \| `initiative` |
| `label` | TEXT | human-readable name ("Project xConnect Onboarding") |
| `status` | TEXT | derived from `subject_state` — the authoritative state comes from there; this is a denormalized copy for fast listing |
| `health_score` | DOUBLE PRECISION | 0-1, mirrored from `subject_state.health` |
| `priority` | INTEGER DEFAULT 3 | 1-5, user-adjustable or derived from deadline urgency |
| `deadline_at` | TIMESTAMPTZ | earliest associated deadline |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

### 3.5 `dependencies` — edges between trackables

Surfaces which goals/projects/tasks depend on each other, including the inferred
chain from the graph.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `source_key` | TEXT NOT NULL | depends-on-that side |
| `target_key` | TEXT NOT NULL | depended-upon side |
| `dep_type` | TEXT | `blocks` \| `required_for` \| `precedes` |
| `derived_from_fact` | UUID FK → derived_facts | the fact that established this dependency |
| `confidence` | DOUBLE PRECISION | from the fact |
| `active` | BOOLEAN DEFAULT TRUE | |
| UNIQUE `(user_id, source_key, target_key, dep_type)` | | |

### 3.6 `contradictions` — conflicting facts

Detected when two facts about the same subject assert incompatible states.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `fact_a_id` | UUID FK → derived_facts | |
| `fact_b_id` | UUID FK → derived_facts | |
| `conflict_description` | TEXT | "Fact A says contract is signed; Fact B says contract is unsigned." |
| `resolution` | TEXT | `unresolved` \| `resolved_by_recency` \| `resolved_by_confidence` \| `resolved_by_source_authority` \| `resolved_by_user` |
| `resolution_detail` | JSONB | which fact won, why |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |
| `resolved_at` | TIMESTAMPTZ | |

### 3.7 `inference_audit` — append-only log

Mirrors `memory_merge_audit` (`018_memory_dedup.sql:52-72`). Every inference run writes
one row per derived fact created/updated/retracted. Columns: `run_id`, `user_id`,
`trigger` (incremental|sweep|backfill), `fact_id`, `action` (created|updated|retracted|
superseded), `prev_version`, `new_version`, `derivation_rule`, `derived_by`,
`detail` JSONB, `created_at`. Append-only; users read their own. This **is** the
undo log for the derived layer.

---

## 4. Inference pipeline

Runs as a new `llm_jobs` job type: `knowledge_inference` (free TEXT — no enum migration
needed per `011_reconstruct_schema.sql:73-99`). Dispatched by `llm-worker`
(`index.ts:621-770`) inside a new switch branch that honors all existing worker
invariants.

### 4.1 Triggers

| # | Trigger | Scope | Producer |
|---|---|---|---|
| 1 | **Event-driven** | New `graph_construction` job completes (design 034) and edges were created → enqueue `knowledge_inference` scoped to affected subjects | llm-worker, tail of graph construction handler |
| 2 | **Memory lifecycle change** | A memory enters `archived` or `expired` state (design 035) → may invalidate derived facts → enqueue inference for affected subjects | lifecycle sweep handler |
| 3 | **Scheduled re-inference** | pg_cron, medium frequency (~15 min), sweeps subjects whose source facts/edges have changed since `last_inferred_at` | pg_cron → enqueue `scope:sweep` |
| 4 | **Backfill** | One-shot `scope:backfill` job for existing users | manual trigger / deploy script |

**Idempotency guard:** same pattern as `memory-extraction` (`llm-worker:52-79`) —
check for existing pending/processing `knowledge_inference` for same `(user_id, scope)`;
return existing job ID if found.

### 4.2 Pipeline stages

```
claim knowledge_inference job
 └─ for each affected subject:
     ┌──────────────────────────────────────────────────┐
     │ STAGE 1: GATHER subgraph                          │
     │  - query graph edges for subject (typed traversal,│
     │    max 3 hops from design 034 RPCs)               │
     │  - query memory_records for subject               │
     │  - query existing derived_facts for subject       │
     │  - query subject_state (current state)            │
     │  - output: subgraph DAG + memory set              │
     ├──────────────────────────────────────────────────┤
     │ STAGE 2: RULE-BASED derivations (always runs)     │
     │  - transitive dependency blocking                 │
     │      (A requires B, B blocked ⟹ A at risk)       │
     │  - state transition detection                     │
     │      (all tasks complete + no blockers → done)   │
     │  - contradiction detection                        │
     │      (two facts assert incompatible states)       │
     │  - deadline risk                                  │
     │      (deadline < 3d + no activity + no progress) │
     │  - missing dependency                             │
     │      (project has owner but no deadline;          │
     │       commitment has no assigned person;          │
       expected reply not received)               │
     │  - relationship inference (transitivity)          │
     │  output: derived facts (rule provenance)          │
     ├──────────────────────────────────────────────────┤
     │ STAGE 3: LLM-BASED derivations (optional)         │
     │  - construct prompt with subgraph + memories      │
     │      + existing derived facts                     │
     │  - LLMRouter.execute() → candidate derived facts  │
     │  - if rule-engine sentinel → skip, use rules only │
     │  - LLM output: statements + fact_type + confidence│
     │  - merge with rule-based output (dedup on         │
     │      fact_key; LLM wins ties if confidence higher)│
     │  output: consolidated derived fact set            │
     ├──────────────────────────────────────────────────┤
     │ STAGE 4: CONTRADICTION check                      │
     │  - pairwise compare all facts for subject         │
     │  - rule: incompatible states (signed vs unsigned, │
     │      active vs completed, blocked vs healthy)     │
     │  - insert/update contradictions table             │
     │  - flag contradictory facts with reduced          │
     │      confidence                                   │
     ├──────────────────────────────────────────────────┤
     │ STAGE 5: CONFIDENCE scoring (§8)                  │
     ├──────────────────────────────────────────────────┤
     │ STAGE 6: UPSERT derived_facts                     │
     │  - upsert by (user_id, fact_key) → idempotent     │
     │  - upsert fact_evidence rows (by fact_id, source) │
     │  - update subject_state (if state changed)        │
     │  - update trackables (if health/status changed)   │
     │  - upsert dependencies                            │
     │  - write inference_audit rows                     │
     │  - retract superseded facts (set active=false,     │
     │      valid_until=now(), log to audit)             │
     └──────────────────────────────────────────────────┘
```

### 4.3 Rule-based derivation catalogue (exhaustive, deterministic)

These run **always** — no LLM, no network call. The LLM stage optionally
augments/refines them. Every rule has an audit log entry.

| Rule name | Trigger condition | Fact produced | Confidence formula |
|---|---|---|---|
| `transitive_dependency_blocked` | A `requires` B, B is `blocked` | "A is at risk because B is blocked" | `min(conf(A_req_B), conf(B_blocked)) × 0.90` |
| `missing_deadline` | Project/commitment tracked, no `deadline_at` in any associated memory | "X has no deadline" | 0.85 (deterministic — absence is verifiable) |
| `missing_owner` | Project active, no `works_on` / `assigned_to` edge to a Person node | "X has no owner" | 0.80 |
| `expected_reply_missing` | Email sent (source memory) + 7 days elapsed + no reply memory/event | "Expected reply to X not received" | `0.75 × recency_decay(age_days, 14)` |
| `deadline_at_risk` | deadline_at < 3d away + no activity in 7d + project state ∉ {completed} | "X deadline is at risk" | 0.70 |
| `state_from_edges` | All edges mark progress → state transition feasible | "X appears to be [state]" | aggregate edge confidences by min |
| `contradiction_pair` | Two facts about same subject assert incompatible states | "[Fact A] and [Fact B] contradict" | 0.90 (detection is deterministic; conflict is certain) |
| `orphan_subject` | Entity has graph edges but no `entity_mention` in active memories | "X is disconnected from any memory" | 0.60 |

---

## 5. Contradiction detection (requirement 7)

Detected in Stage 4. **Detection** is rule-based (pairwise state incompatibility);
**resolution** follows a deterministic policy with optional LLM escalation.

### 5.1 Incompatibility matrix (excerpt)

| State A | State B | Conflict? |
|---|---|---|
| `active` | `completed` | Yes — can't be both |
| `blocked` | `healthy` | Yes |
| `signed` | `unsigned` | Yes |
| `in_progress` | `stalled` | No (informational — stalled is a sub-state of in_progress) |
| `at_risk` | `blocked` | No (blocked implies at_risk) |

### 5.2 Resolution policy (deterministic, with overrides)

Run in priority order:

1. **Recency wins:** if one fact's sources are all `last_seen_at >` the other's by >30 days, the newer fact prevails. Confidence is adjusted.
2. **Confidence wins:** if difference >0.20, higher-confidence fact wins.
3. **Source authority:** facts derived from calendar events outrank facts derived from emails (calendar = hard commitment); facts with `verified=true` outrank unverified.
4. **Escalate to LLM:** if all above fail → LLMRouter single-call adjudication; on `rule-engine` → flag `unresolved` for briefing.
5. **User resolution** (future): contradiction persisted, surface in briefing as actionable.

Resolved contradictions: `active=false` on the losing fact with `valid_until=now()`,
`resolution_detail` written to the contradiction row.

---

## 6. State tracking (requirement 3)

Every subject has a deterministic state machine. State transitions happen in Stage 2
(rule-based) and are optionally refined by Stage 3 (LLM).

### 6.1 Project state machine

```
  ┌──────────┐   all_milestones_met    ┌───────────┐    manual_close     ┌───────────┐
  │not_started│──────────────────────►│ completed  │◄─────────────────│ abandoned  │
  └─────┬─────┘                        └───────────┘                    └───────────┘
        │ first_activity
        ▼
  ┌───────────┐   last_activity < 30d   ┌─────────┐
  │ onboarding │───────────────────────►│ stalled  │
  └─────┬─────┘                         └────┬────┘
        │ active_edges                        │ new_activity
        ▼                                     ▼
  ┌──────────┐   blocker_detected    ┌───────────┐
  │  active   │────────────────────►│  blocked   │
  └─────┬────┘                        └─────┬─────┘
        │                                    │ blocker_resolved
        │ deadline < 7d + no progress        │
        ▼                                    ▼
  ┌──────────┐   blocker_resolved    ┌───────────┐
  │ at_risk  │◄─────────────────────│  blocked   │
  └──────────┘                        └───────────┘
```

Transitions are **always** logged to `inference_audit`. `state_since` records when the
current state was entered, enabling "project has been blocked for 12 days" trending.

---

## 7. Project & dependency tracking (requirements 4-6)

### 7.1 Project health rollup

```
  health = W_TASKS × task_completion_ratio
         + W_BLOCKERS × (1 - max_blocker_severity/1.17)
         + W_DEADLINE × deadline_health
         + W_ACTIVITY × activity_health

  Defaults (tunable via env):
    W_TASKS=0.30, W_BLOCKERS=0.35, W_DEADLINE=0.20, W_ACTIVITY=0.15
```

| Component | Computation |
|---|---|
| `task_completion_ratio` | completed_tasks / total_associated_tasks (from graph edges + derived facts) |
| `max_blocker_severity` | `max(severity)` of active blocker-type derived facts for this subject; 1.17 normalization factor so 3-blocker with sev=0.39 maps to ~0 |
| `deadline_health` | exp(-days_until_deadline / 14) if deadline exists, else 0.5 |
| `activity_health` | exp(-days_since_last_activity / 30) |

### 7.2 Dependency chain traversal

For any trackable, the engine computes:

1. **What I block:** `SELECT target_key FROM dependencies WHERE source_key = X AND active`
2. **What blocks me:** `SELECT source_key FROM dependencies WHERE target_key = X AND active`
3. **Transitive risk:** if anything up the chain is `blocked` or `at_risk`, propagate a
   risk signal with decaying strength: `risk = upstream_strength × 0.7^hops`.
4. **Critical path:** the longest blocking chain (by summed severity) → surfaced as a
   briefing priority.

This traversal reuses the multi-hop graph traversal designed in 034 (typed edges,
recursive CTE, per-hop decay).

---

## 8. Confidence propagation (requirement 8)

Confidence flows from source memories through inference rules to derived facts.

### 8.1 Source confidence normalization

A source memory's normalized confidence:

```
mem_conf = (confidence_score / 100) × (verified ? 1.0 : 0.8)
```

Graph edges carry their own `confidence` (from design 034's edge creation).

### 8.2 Rule-based derivation confidence

```
fact_conf = chain_rule(source_confidences, rule_multiplier)

chain_rule for "all sources required":
  base = min(all source_confidences)
chain_rule for "any source sufficient":
  base = max(all source_confidences)
rule_multiplier = fixed per rule (see §4.3 table)
```

The `fact_evidence.evidence_role` (`primary`/`supporting`/`context`) weights
contributions: primary sources get full weight, supporting 0.7, context 0.3.

### 8.3 Lifecycle decay integration

When source memories enter `dormant` or `archived` state (design 035), their
contribution to derived fact confidence drops:

| Source lifecycle state | Confidence multiplier |
|---|---|
| `active` | 1.0 |
| `dormant` | 0.7 |
| `archived` | 0.3 |
| `expired` | fact is RE-EVALUATED (may retract) |

If a derived fact's confidence drops below `FACT_CONFIDENCE_FLOOR` (default 0.25),
it is marked `active=false` and re-inference is queued.

### 8.4 Retrieval reinforcement

Derived facts have their own `retrieval_count` + `last_retrieved_at` (mirror of
`memory_records` Phase 32). When a derived fact is included in the final assembled
retrieval context, the `record_memory_retrievals`-style RPC bumps it
(`record_fact_retrievals`). This feeds the same reinforcement → decay counteraction
model from lifecycle design 035.

---

## 9. Retrieval integration (requirement 9)

Derived facts enter the retrieval path as first-class items.

### 9.1 New RPC: `hybrid_search_derived_facts`

Mirrors `hybrid_search_memories` (`032_retrieval_ranking_signals.sql:19-57`):

```sql
-- Signature: (query_text TEXT, query_embedding vector(768), match_count INT DEFAULT 10)
-- Returns: id, statement, fact_type, subject_type, subject_id, confidence,
--          severity, created_at, similarity_distance
-- Filter: user_id = auth.uid(), active = TRUE, (valid_until IS NULL OR valid_until > now())
-- Order: embedding <=> query_embedding LIMIT match_count
```

### 9.2 Ranker integration (`ranker.ts`)

A derived fact is a ranked item with these signals:

| Signal | Value source |
|---|---|
| semantic | `1 - similarity_distance` (from hybrid_search_derived_facts) |
| importance | `confidence × severity` (fact-specific, higher weight for blockers/risks) |
| urgency | derived from associated `deadline_at` (through subject's trackable) |
| recency | `exp(-ageDays / 30)` on `created_at` |
| reinforcement | `log1p(retrieval_count) / log1p(50)` — same formula as memories |

No new weight is added — derived facts compete in the existing composite formula
(`ranker.ts:54-58`). A small nudge prioritizes blocker/risk types:
`importance = confidence × severity × (fact_type IN (blocker,risk) ? 1.2 : 1.0)`.

### 9.3 Assembler integration (`assembler.ts`)

New format branch (alongside existing `[Memory - ...]`, `[Email]`, `[Event]`):

```
[Derived - {fact_type}] {statement}  (confidence: {confidence}, severity: {severity})
```

The existing `source_hash`/text dedup in `assembler.ts` handles derived facts naturally
(synthetic hash from `fact_key`). Token budget unchanged (~2000 words).

### 9.4 Retrieval flow (updated)

```
hybrid_search_memories ─┐
hybrid_search_emails    ─┤
hybrid_search_events    ─┤  → [collapse via consolidation] → ranker.ts → assembler.ts
hybrid_search_clusters  ─┤
hybrid_search_derived   ─┘     // NEW
```

---

## 10. Briefing integration (requirement 10)

The Autonomous Briefing Intelligence (design 037) is the primary consumer of the
engine's output. The engine exposes structured data via:

1. **Direct query:** briefing pipeline reads `derived_facts` (blockers/risks/trends),
   `subject_state` (project health), `dependencies` (transitive blocking chains),
   `contradictions` (unresolved conflicts), filtered by `user_id` + recency/severity
   thresholds.

2. **Push via state change:** when `subject_state` transitions to `blocked` or
   `at_risk`, the engine writes a derived fact with `severity > 0.5` — the briefing's
   risk-detection stage picks it up.

3. **The "missing information" signal** (`expected_reply_missing`, `missing_deadline`,
   `missing_owner`) is surfaced by the engine as derived facts of type `missing_info`,
   consumed directly by the briefing's missing-information detection stage.

4. **ProcessBriefingGeneration integration** (`llm-worker:501-619`): the briefing
   gathering stage reads derived facts alongside memories/emails/events; the
   `ruleBasedBriefing` fallback includes a derived-fact summary section.

---

## 11. Failure handling

| Failure mode | Response |
|---|---|
| LLM inference down (OmniRoute unavailable or `rule-engine` sentinel) | Stage 3 is skipped entirely; Stage 2 rule-based derivations are sufficient for all 10 requirement types. No derived fact is LLM-only — rules are the floor. |
| Partial graph (graph_construction not yet run for a subject) | Gathered subgraph is empty → rule-based derivations work on memories alone (weaker but functional). Derived facts flagged `derived_by='rule-engine'`, confidence lower. |
| Stale derived facts (source memories expired) | Confidence recalculated (§8.3). If below floor, fact retracted. A sweep job detects and re-infers. |
| Inference run timeout (>55s cron limit) | Worker's `MAX_JOBS_PER_RUN` chunks by subject. Partial run → partial results committed. Remaining subjects re-enqueued. |
| Contradiction with user-corrected fact | User manual resolution (Phase 2+ feature) writes to `contradictions.resolution='resolved_by_user'`; engine skips re-deriving the losing fact. |
| Telemetry | New `inference_runs` and `inference_errors` tables (mirror `retrieval_runs`/`retrieval_failures` from `019_retrieval_observability.sql:13-56`). Best-effort, never blocks inference. |

---

## 12. Rollback strategy

Three tiers, same pattern as consolidation design §7:

### Tier 1 — Feature flags (instant)

- `KNOWLEDGE_ENGINE_WRITE_ENABLED` — controls whether inference jobs execute
  (off → jobs enqueued but worker no-ops).
- `KNOWLEDGE_ENGINE_READ_ENABLED` — controls whether `hybrid_search_derived_facts`
  participates in retrieval and whether derived facts appear in briefings.
- Both off → system is byte-for-byte pre-engine behavior.

### Tier 2 — Drop the layer

Drop the five tables (`derived_facts`, `fact_evidence`, `subject_state`, `trackables`,
`dependencies`, `contradictions`, `inference_audit`) and the `hybrid_search_derived_facts`
RPC. Retrieval and briefing revert to today's exact paths. **No source data is lost** —
the engine never writes to `memory_records`/`entity_mentions`/graph tables.

### Tier 3 — Surgical undo

`inference_audit` enables targeted reversal: retract a bad derived fact, revert a wrong
state transition, replay inference for a specific subject from a known-good version.
`version` column on `derived_facts` enables optimistic concurrency.

---

## 13. Migration plan

**Migration 036** — `036_knowledge_engine.sql`:

- `CREATE TABLE IF NOT EXISTS` for all seven tables with columns per §3.
- Enable RLS per existing pattern (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`).
- Per-user policies: `CREATE POLICY ... FOR SELECT USING (auth.uid() = user_id)`.
  Service-role bypasses RLS (inference engine uses `supabaseAdmin`).
- Indexes per §3 (`IF NOT EXISTS`). ivfflat on `derived_facts.embedding` must follow
  existing `vector(768)` + `vector_cosine_ops` + `lists=100` convention.
- New RPCs: `hybrid_search_derived_facts` (SECURITY DEFINER, granted to authenticated);
  `record_fact_retrievals` (service-role, mirrors `record_memory_retrievals`).
- Idempotent policy drops: `DROP POLICY IF EXISTS ... ON ...`.
- No ALTERs to existing tables. New `job_type` = free TEXT, no constraint migration.

**Backfill:** a separate `knowledge_inference` job with `scope:backfill` pages existing
users' `entity_mentions` + graph edges (if graph backfill done first), builds derived
facts user-by-user, honors worker budget (`MAX_JOBS_PER_RUN=5`) and 55s cron timeout.

---

## 14. Testing strategy

### 14.1 Unit / integration tests (Deno)

| Test | What it validates |
|---|---|
| `rule_transitive_blocker()` | Given memories m1,m2,m3 and edges e1(project→task), e2(task→email), verify derived fact "project blocked" with confidence in [0.7,0.85] |
| `rule_missing_deadline()` | Memory with commitment + no deadline_at → `missing_deadline` fact |
| `rule_expected_reply_missing()` | Email sent 8 days ago, no reply → `expected_reply_missing` fact |
| `rule_contradiction_pair()` | Two facts asserting `signed` vs `unsigned` → contradiction row |
| `confidence_propagation_product()` | Input confidences 0.9, 0.8, 0.7 → `min([0.9,0.8,0.7]) × 0.90` = 0.63 |
| `lifecycle_decay()` | Source memory archived → fact confidence drops by 0.7×; source expired → fact retracted |
| `state_transition()` | All tasks complete + no blockers → project state → `completed` |
| `dependency_chain()` | A→B→C blocked → A gets risk signal 0.7² × C.severity |
| `llm_fallback()` | LLMRouter returns rule-engine → Stage 3 skipped, output is rule-only but complete |
| `idempotent_upsert()` | Run inference twice on same input → no duplicate facts, version bumped, audit logged |
| `rollback_flags()` | READ flag off → derived facts not in retrieval; WRITE flag off → no inference runs |

### 14.2 End-to-end fixture: the Versant/onboarding case

```
Setup:
  - Insert m1 (Contract signed, confidence=85)
  - Insert m2 (Follow-up pending, confidence=70)
  - Insert m3 (Versant email missing, confidence=90)
  - Insert graph edges: Project:onboarding depends_on Task:versant-followup
                       Task:versant-followup requires Email:versant-outreach
  - Insert graph edge: Email:versant-outreach status=unsent

Run: knowledge_inference job (scope: 'onboarding')

Assert:
  - derived_fact exists: "Project onboarding is blocked by missing Versant email"
  - fact_type = 'blocker'
  - confidence ∈ [0.7, 0.85]
  - evidence: m1,m2,m3 + edges
  - subject_state('project', 'onboarding') = 'blocked'
  - project health < 0.5
  - dependence: onboarding blocked_by versant-followup
  - inference_audit: 1 run, N actions logged
  - memory_records unchanged (invariant validated)
```

### 14.3 CI integration

- `deno test supabase/functions/knowledge-inference/*.test.ts` (if edge function tests)
  or `deno test tests/knowledge-engine/*.test.ts`.
- RPC tests via `supabase.rpc()` in Deno with a local Postgres instance.
- Flag toggle tests: set env, assert no derived facts produced/consumed.

---

## 15. Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Inference trigger | **Async via llm_jobs** | Inline at extraction or DB trigger | LLM work must be async per central pattern; Postgres triggers can't call LLMs in-txn. Cost: eventual consistency (seconds–minutes). |
| Derivation floor | **Rules always; LLM optional** | LLM-only, or rules-only | Deterministic baseline for all 10 requirement types; LLM enriches but never blocks. Matches existing rule-engine fallback pattern. |
| Derived fact identity | **fact_key on (statement+subject+type)** | Sequence/PK only | EnKG enabled upsert; no duplicates across inference runs. |
| Confidence model | **Min-of-sources × rule-multiplier** | Product/bayesian | Simple, interpretable, conservative. Product-of-probs decays too fast for deep chains. |
| State machine | **Deterministic rules + LLM annotation** | Pure LLM state inference | States are verifiable from graph structure; LLM adds summary but not decision authority. |
| Where derived facts rank | **Same ranker formula, fact-type nudge** | Separate ranking pipeline | Additive, flag-reversible, no weight retuning. |
| Subject storage | **Dedicated tables (subject_state, trackables, dependencies)** | Denormalized into derived_facts only | Structured queries for briefing ("all blocked projects") are fast; state machine is explicit + auditable. |
| Contradiction resolution | **Deterministic policy (recency→confidence→authority→LLM)** | Always LLM, or always newest-wins | Deterministic in common cases; LLM for edge cases; never blocks with ambiguity. |
| Dependencies | **Separate table** | Inferred on-the-fly from graph | Transitive blocking chain queries are constant-time reads; the graph is the source but the dependency table is the cache. |

---

## 16. Worked example: onboarding blocker

### Setup (existing facts + graph)

```
memory_records:
  m1: [commitment] "Contract for Keerthana Rao is signed"
      confidence_score=85, verified=false → src_conf = 0.68
  m2: [commitment] "Versant follow-up is pending"
      confidence_score=70, verified=false → src_conf = 0.56
  m3: [email] "Versant onboarding email not yet received"
      confidence_score=90, verified=true → src_conf = 0.90

graph (from design 034):
  n1 (Person:Keerthana Rao) -works_on→ n2 (Project:xConnect Onboarding)
  n2 -blocked_by→ n3 (Task:Versant Follow-up)
  n3 -requires→ n4 (Email:Versant Outreach Email)
  edge: n4 status=unsent (confidence=0.95)
```

### Inference run (`scope: 'xconnect-onboarding'`)

**Stage 1 — Gather:**
- Subject = project `xConnect Onboarding`
- Subgraph: 4 nodes, 4 edges (2 hops from project)
- Memories: m1, m2, m3 (via entity co-mention + graph backlinks)
- Existing derived facts: none (fresh)
- Current subject_state: `not_started`

**Stage 2 — Rule-based derivations:**

Rule `transitive_dependency_blocked` fires:
- Chain: xConnect Onboarding `blocked_by` Versant Follow-up (edge conf 0.95)
- Versant Follow-up `requires` Versant Outreach Email (edge conf 0.90)
- Versant Outreach Email status = unsent (edge conf 0.95)
- → derived fact: "xConnect Onboarding is blocked because Versant Outreach Email has not been sent"
- confidence = `min(0.95, 0.90, 0.95) × 0.90 = 0.81`
- severity = `max(edge severities) = 0.80`

Rule `state_from_edges` fires:
- Project has blocker → state = `blocked`
- health = `0.30×0.0 + 0.35×(1-0.80/1.17) + 0.20×0.5 + 0.30×0.9 = 0 + 0.11 + 0.10 + 0.27 = 0.48`

Rule `missing_deadline` fires:
- Project has no `deadline_at` in any associated memory
- → derived fact: "xConnect Onboarding has no deadline" (confidence 0.85)

**Stage 3 — LLM (optional, runs successfully):**
- Produces additional fact: "Keerthana Rao is a key collaborator on xConnect Onboarding and her contract is signed but onboarding is stalled pending Versant" (fact_type=relationship, confidence=0.75)
- Merged with rule output (dedup by fact_key; no conflict with the blocker fact).

**Stage 4 — Contradiction check:**
- No conflicting facts found (this is a fresh subject).

**Stage 5 — Confidence:**
- All computed in Stage 2/3.

**Stage 6 — Upsert:**
- `derived_facts`: 3 rows upserted (blocker + missing_deadline + relationship)
- `fact_evidence`: 9 rows (3 per fact, linking m1/m2/m3 + graph edges)
- `subject_state`: upsert `(project, xconnect-onboarding)` → state=`blocked`, health=0.48
- `trackables`: upsert `xconnect-onboarding` → status=`blocked`, health_score=0.48
- `dependencies`: upsert `xconnect-onboarding` `blocked_by` `versant-follow-up`
- `inference_audit`: 7 rows (3 fact_created + 1 state_updated + 1 trackable_updated + 1 dependency_upserted + 1 run_completed)

### Retrieval impact

Query *"what's blocking onboarding?"*:
- `hybrid_search_derived_facts` returns the blocker fact (similarity high, confidence 0.81).
- Ranker scores it: semantic~0.92, importance~0.81×0.80=0.65, urgency~0.7 (deadline risk from missing_deadline fact), recency~1.0 (just created), reinforcement~0.
- Composite: `0.50×0.92 + 0.20×0.70 + 0.15×0.65 + 0.10×1.0 + 0.05×0 = 0.46 + 0.14 + 0.10 + 0.10 + 0 = 0.80` → surfaces above the 0.3 threshold.
- Assembler renders: `[Derived - blocker] xConnect Onboarding is blocked because Versant Outreach Email has not been sent (confidence: 0.81, severity: 0.80)`

All source memories (m1, m2, m3) remain queryable individually. The derived layer is
fully droppable and rebuildable. **No original fact was altered.**

---

**File written:** `D:\cyrus v2\docs\superpowers\specs\2026-06-23-personal-knowledge-engine-design.md`