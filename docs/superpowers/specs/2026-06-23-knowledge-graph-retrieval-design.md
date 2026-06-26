# Knowledge Graph & Multi-Hop Retrieval System — Design Document

**Status:** Architecture only (no implementation)
**Date:** 2026-06-23
**Scope:** Cyrus V2 retrieval layer (`memory_records`, `entity_mentions`, `memory_clusters`, `retrieve-context`, `llm-worker`)
**Migration:** `034_knowledge_graph.sql` (033 reserved for memory consolidation)
**Adjacent designs:** builds on `2026-06-23-memory-consolidation-design.md` (033); consumed by the Personal Knowledge Engine (`036`) and Autonomous Briefing Intelligence (`037`) docs.

---

## 1. Problem

Today the "graph" in Cyrus V2 is **entity co-mention navigation**, not a graph of
typed relationships.

`entity_mentions` (`021_graph_retrieval.sql:11-18`) links a memory to the bare
proper-noun strings it mentions — extracted by a capitalized-phrase regex capped at
10/memory (`llm-worker:21-30`). `graph_expand_memories`
(`032_retrieval_ranking_signals.sql:62-112`) is a recursive CTE that walks
*memory → shared-entity → memory* up to 2 hops. It answers "what other memories
mention a word this memory also mentions?" — useful for context expansion, but it
cannot express or traverse **typed, directional relationships**:

```
?  Keerthana Rao  —works_on→  xConnect  —blocked_by→  Versant email
```

The co-mention walk would only reach that email if some memory happened to contain
both the strings "xConnect" and "Versant" verbatim, and it could never tell the
ranker *why* (a dependency) or in which *direction*. There are:

- **no typed nodes** (a "Keerthana Rao" the *Person* vs. the *string*),
- **no typed edges** (`works_on`, `blocked_by`, `depends_on`, `signed`…),
- **no edge attributes** (confidence, validity window, evidence memory),
- **no path semantics** the ranker or assembler can render as a statement.

The Personal Knowledge Engine (`036`) needs exactly this: to *derive facts*
("Project onboarding is blocked by a missing Versant email") it must traverse
`Person -works_on-> Project -blocked_by-> Email` as a **first-class typed query**.

This document designs a **knowledge graph layer** — typed nodes + typed edges,
derived from `memory_records`/`entity_mentions`, anchored on consolidation clusters
where they exist — plus a **multi-hop typed traversal** that generalizes
`graph_expand_memories` and feeds the existing `ranker.ts`/`assembler.ts` pipeline.

### Design constraints (from the codebase)

- `CLAUDE.md`: *avoid schema changes unless the task requires one; prefer logic.* A
  typed graph genuinely needs persistent node/edge tables — but we add **zero
  columns to `memory_records`** and keep the whole layer **derived and droppable**.
- Migrations are strictly ordered and **idempotent** (`CREATE … IF NOT EXISTS`,
  `DROP POLICY IF EXISTS`); CI runs a clean `supabase db reset`.
- **RLS everywhere** (`auth.uid() = user_id`); edge functions use the service-role key
  and must filter `user_id` explicitly.
- Long/LLM work is **never inline** — it flows through `llm_jobs` + `llm-worker`
  (reclaim → claim → retry → dead-letter invariants, `llm-worker:713-736`).
- LLM relation extraction routes through `LLMRouter` with the `rule-engine` sentinel
  fallback; embeddings are `vector(768)`.

---

## 2. Core principle: the graph is a *derived, additive* projection

```
                       ┌──────────────────────────────────────────────┐
 SOURCE OF TRUTH  ───►  │ memory_records  (UNCHANGED — atomic facts)    │
 (never mutated)        │ entity_mentions (UNCHANGED — co-mention edges) │
                       └───────────────┬──────────────────────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼ (033, optional anchor)         ▼                                │
 ┌──────────────────┐         ┌────────────────────────────────────┐    │
 │ memory_clusters  │  node   │  graph_nodes   (typed entities)     │    │
 │ (entity profiles)│◄──link──│  graph_edges   (typed relationships)│◄───┘ provenance
 └──────────────────┘ identity│  graph_node_members (node ↔ memory) │   (evidence_memory_id)
   DERIVED LAYER (033)        │  graph_build_audit (append-only)    │
                              └───────────────┬────────────────────┘
                                  DERIVED LAYER (034) — this doc
                                              ▼
                              ┌────────────────────────────────────┐
 QUERY TIME       ───►         │ retrieve-context:                  │
                              │  hybrid_search_* → seed nodes →     │
                              │  graph_traverse_typed (multi-hop) → │
                              │  ranker.ts (+graph signal) →        │
                              │  assembler.ts (path statements)     │
                              └────────────────────────────────────┘
```

The invariant that makes everything safe: **a node/edge is a function of
`memory_records` + `entity_mentions` (+ `memory_clusters`).** It is always
reconstructable. Dropping the new tables returns the system to today's exact
behavior (graph traversal silently degrades to `graph_expand_memories`). This is
what makes rollback trivial (§10) and the migration low-risk (§ Migration plan).

**Relationship to consolidation (033):** a `memory_clusters` row with
`cluster_key = entity:<name>` already *is* the canonical entity. The graph **reuses
it as the node** rather than minting a parallel identity. Where a cluster exists, the
`graph_nodes` row points at it (`cluster_id`) and inherits its `centroid`, `label`,
and `importance`. Where consolidation has not (yet) materialized a cluster, the graph
falls back to an entity-string node derived directly from `entity_mentions`. The
graph **never** duplicates cluster content.

---

## 3. Storage design

Four new tables (+ one audit). **No changes** to `memory_records`, `entity_mentions`,
`memory_clusters`, or `llm_jobs` schema (`job_type` is free TEXT, so the new
`graph_construction` value needs no migration).

### 3.1 `graph_nodes` — typed entity nodes

| column | type | purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS / tenant isolation |
| `node_key` | TEXT NOT NULL | normalized canonical key, `"<type>:<name>"` e.g. `person:keerthana rao`. Basis of UNIQUE `(user_id, node_key)` → idempotent upsert |
| `node_type` | TEXT NOT NULL | taxonomy (§4): `person` \| `project` \| `task` \| `organization` \| `contract` \| `communication` \| `topic` \| `unknown` |
| `label` | TEXT | human-readable display name ("Keerthana Rao") |
| `cluster_id` | UUID FK → memory_clusters (nullable, ON DELETE SET NULL) | **the link to consolidation.** If set, the node *is* that cluster; inherits its profile. NULL = entity-only node not yet consolidated |
| `centroid` | vector(768) | inherited from the cluster, else mean of member-memory embeddings — lets nodes be retrieved directly by vector search |
| `importance` | DOUBLE PRECISION | rolled up `max(member.llm_importance, member.system_importance)` |
| `mention_count` | INTEGER | denormalized; degree/centrality signal |
| `confidence` | DOUBLE PRECISION | how sure we are this node is a real entity (string-only nodes start lower than cluster-backed) |
| `version` | INTEGER DEFAULT 1 | bumped per build; optimistic concurrency + targeted rollback |
| `active` | BOOLEAN DEFAULT TRUE | soft-delete (mirrors `memory_records.active`) |
| `last_built_at` | TIMESTAMPTZ | staleness signal for reconciliation |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Identity / dedup:** a node is keyed by `(user_id, node_key)` where
`node_key = lower(node_type || ':' || canonical_name)`. Canonicalization reuses the
existing entity-string normalization (lowercase, the case-insensitive predicate
`graph_expand_memories` already uses, `032:94`). When consolidation later merges two
clusters, the build job repoints both `graph_nodes` to the surviving `cluster_id` and
re-keys (audited) — see §6.

### 3.2 `graph_node_members` — node ↔ source memories (provenance)

| column | type | purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `node_id` | UUID FK → graph_nodes ON DELETE CASCADE | |
| `memory_id` | UUID FK → memory_records ON DELETE CASCADE | **memories are referenced, never copied** |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Constraint:** UNIQUE `(node_id, memory_id)`. This is the provenance spine: every
node traces back to the `memory_records` that evidence it. `ON DELETE CASCADE` means
expiry/soft-delete of a fact auto-prunes its node membership; the node self-heals on
the next build. (Where a `cluster_id` is set, cluster membership in
`memory_cluster_members` is authoritative and this table mirrors it.)

### 3.3 `graph_edges` — typed, directional relationships

| column | type | purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `src_node_id` | UUID FK → graph_nodes ON DELETE CASCADE | tail of the directed edge |
| `dst_node_id` | UUID FK → graph_nodes ON DELETE CASCADE | head of the directed edge |
| `edge_type` | TEXT NOT NULL | typed relation (§5): `works_on` \| `blocked_by` \| `depends_on` \| `assigned_to` \| `signed` \| `owns` \| `part_of` \| `mentions` \| … |
| `confidence` | DOUBLE PRECISION | extraction confidence (LLM logit/heuristic; asserted=1.0, inferred<1.0) |
| `origin` | TEXT | `asserted` (stated in a memory) \| `inferred` (LLM-derived) \| `rule` (deterministic fallback) |
| `evidence_memory_id` | UUID FK → memory_records ON DELETE SET NULL | the memory that justifies this edge — provenance back to source of truth |
| `valid_from` | TIMESTAMPTZ | when the relationship became true (≈ `evidence.created_at` / `deadline_at`) |
| `valid_to` | TIMESTAMPTZ (nullable) | invalidation time; NULL = currently valid. Soft-expiry without delete |
| `version` | INTEGER DEFAULT 1 | |
| `active` | BOOLEAN DEFAULT TRUE | soft-delete |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Constraint:** UNIQUE `(user_id, src_node_id, dst_node_id, edge_type)` — at most one
*active* typed edge per (src, type, dst); re-extraction **upserts** (bumps
`confidence`/`version`, refreshes `valid_*`) rather than duplicating. A reverse
relation is its **own** row (`blocked_by` is stored directed; traversal may follow
edges in reverse with a decay penalty, §7).

**Asserted vs inferred:** `origin='asserted'` edges come from a single memory that
states the relation directly ("xConnect is blocked by the Versant email") →
`evidence_memory_id` set, `confidence≈1.0`. `origin='inferred'` edges are LLM-derived
from co-occurrence/context across members → lower confidence, `evidence_memory_id` =
the strongest supporting memory. `origin='rule'` edges are the deterministic fallback
(§ failure handling): every `entity_mentions` co-occurrence within one memory becomes a
generic `mentions` edge — i.e. the graph degrades *exactly* to today's untyped
co-mention behavior when the LLM is unavailable.

### 3.4 `graph_build_audit` — append-only action log

Mirrors `memory_merge_audit` (`018_memory_dedup.sql`) and the consolidation audit
(033). One row per build action: `node_created` | `node_merged` | `edge_added` |
`edge_invalidated` | `edge_reweighted` | `node_deactivated` | `rebuild`. Columns:
`node_id`/`edge_id` (nullable), `action`, `reason`, `adjudicator` (provider or
`rule-engine`), `prev_version`, `new_version`, `detail` JSONB, `created_at`. This is
the **undo log** (§10) and the observability surface. Append-only; users read their own.

### 3.5 Indexes & RLS

```sql
-- identity & lookups
CREATE UNIQUE INDEX IF NOT EXISTS uq_graph_nodes_key
  ON public.graph_nodes (user_id, node_key);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_user_active
  ON public.graph_nodes (user_id, active);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_cluster
  ON public.graph_nodes (cluster_id);
-- direct vector retrieval of nodes (mirror idx_memory_records_embedding)
CREATE INDEX IF NOT EXISTS idx_graph_nodes_centroid
  ON public.graph_nodes USING ivfflat (centroid vector_cosine_ops) WITH (lists = 100);

-- traversal hot paths: outgoing & incoming, type-filtered
CREATE INDEX IF NOT EXISTS idx_graph_edges_src
  ON public.graph_edges (user_id, src_node_id, edge_type) WHERE active;
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst
  ON public.graph_edges (user_id, dst_node_id, edge_type) WHERE active;

-- provenance
CREATE INDEX IF NOT EXISTS idx_graph_node_members_memory
  ON public.graph_node_members (memory_id);
CREATE INDEX IF NOT EXISTS idx_graph_node_members_node
  ON public.graph_node_members (node_id);
```

RLS on all tables: `ENABLE ROW LEVEL SECURITY`, per-user `SELECT` policy
`auth.uid() = user_id` (`DROP POLICY IF EXISTS` guarded). **Writes are service-role
only** (the build job runs as `supabaseAdmin`); no `INSERT`/`UPDATE`/`DELETE` policy is
granted to `authenticated`. Traversal RPCs are `SECURITY DEFINER`, take `p_user_id`
explicitly, filter on it, and are `GRANT EXECUTE … TO service_role` only — exactly the
`graph_expand_memories` pattern (`021:70-71`).

---

## 4. Node taxonomy

A small, extensible taxonomy. Types are **TEXT, not an enum** (so adding one needs no
migration — consistent with `job_type`). `unknown` is the safe default for entities
the classifier can't type.

| node_type | What it is | Identity source | Typical edges (out / in) |
|---|---|---|---|
| `person` | A human ("Keerthana Rao") | cluster `entity:<name>` or `entity_mentions` | `works_on`→project, `assigned_to`→task, `owns`→contract |
| `project` | A named initiative ("xConnect") | cluster / entity string | `part_of`→org, `blocked_by`→communication/task, `depends_on`→project |
| `task` | An actionable item / commitment | derived from `commitment`-category memories | `assigned_to`(person)→, `part_of`→project, `depends_on`→ |
| `organization` | A company/team | entity string | `owns`→project, `part_of`(person works at) |
| `contract` | A signed agreement | `commitment`/contract-category memory | `signed`(person)→, `part_of`→project |
| `communication` | An email/event surfaced as a graph entity | `source_type` of evidence memory (`emails`/`calendar_events`) | `mentions`→, target of `blocked_by` |
| `topic` | A non-proper-noun subject (later phase) | semantic/topic anchor | `mentions` |
| `unknown` | Unclassifiable entity | entity string | `mentions` only |

**How identity/dedup works (recap §3.1):** `node_key = "<type>:<canonical name>"`,
upserted on `(user_id, node_key)`. **Linking to consolidation clusters** is the
preferred identity path: if a `memory_clusters` row exists for the entity, the node
adopts its `cluster_id`, `centroid`, `label`, and `importance`, guaranteeing the graph
node and the retrieval profile are the *same* object. Type is assigned by (a) the
dominant `category` of the node's member memories (e.g. all-`commitment` → `task`),
falling back to (b) the LLM classifier, falling back to (c) `unknown`.

---

## 5. Edge taxonomy

Typed, **directional** relationships. Like node types, edge types are TEXT and
extensible. v1 ships a deliberately small set; the long tail collapses to `mentions`.

| edge_type | Direction (src → dst) | Inferred or asserted | Notes |
|---|---|---|---|
| `works_on` | person → project | inferred from co-membership; asserted if stated | the canonical "who does what" |
| `blocked_by` | project/task → communication/task | usually asserted ("blocked by the Versant email") | drives the Knowledge Engine's "is blocked" facts |
| `depends_on` | project/task → project/task | inferred/asserted | generic dependency |
| `assigned_to` | task → person | asserted | ownership of an action |
| `signed` | person → contract | asserted (`commitment` memory) | |
| `owns` | person/org → project/contract | inferred/asserted | |
| `part_of` | project → org, task → project | inferred | hierarchy/composition |
| `mentions` | any → any | **rule (fallback)** | the deterministic degrade-to-co-mention edge (§3.3) |

**Directionality:** edges are stored directed. Semantically symmetric relations
(`depends_on` between peers) still pick a canonical src/dst by node_key order to keep
the UNIQUE constraint meaningful; traversal can walk against direction with a decay
penalty (§7). **Attributes** (`confidence`, `valid_from`/`valid_to`,
`evidence_memory_id`, `origin`) live on the edge row (§3.3) — this is what lets the
ranker weight a confident, currently-valid, asserted dependency above a stale inferred
one, and lets the assembler render *why* a path exists.

**Inferred vs asserted decision:** during construction, the relation extractor labels
each edge. If the relation is the literal predicate of a single sentence in one memory
→ `asserted`, `confidence` high, `evidence_memory_id` = that memory. If it's deduced
from multiple members or context → `inferred`, lower confidence. Router failure →
`rule` edges only.

---

## 6. Graph construction pipeline

Construction is a **new `llm_jobs` job type `graph_construction`** (TEXT payload
`{ user_id, node_key? , scope }`, `scope ∈ incremental | sweep | backfill`). It rides
the existing async worker: `llm-worker` gains **one dispatch branch** next to
`memory_extraction` / `briefing_generation` / `generate_embedding`
(`llm-worker:713-720`). The **reclaim → claim → retry → dead-letter invariants are
untouched**.

### 6.1 Handler outline (no code)

```
claim graph_construction job
 └─ for each affected node_key (scope-dependent set):
     1. resolve node:
          - if a memory_clusters row exists (cluster_key=entity:<name>) → adopt
            its id/centroid/label/importance  (LINK, don't duplicate)
          - else gather member memories via entity_mentions (active, not expired),
            compute centroid, derive label
     2. upsert graph_nodes by (user_id, node_key); bump version; reconcile
        graph_node_members (add new evidence, prune removed)
     3. classify node_type (member-category majority → LLM → 'unknown')
     4. extract typed relations among this node and its 1-hop neighbours:
          a. ASSERTED pass (deterministic + cheap): scan member memory text for
             relation predicates / category signals → asserted edges
          b. INFERRED pass (LLM via LLMRouter): prompt with the node + neighbour
             labels + member snippets → typed (src,type,dst,confidence) triples
          c. if router returns the rule-engine sentinel → RULE pass only:
             emit generic `mentions` edges from entity co-occurrence (today's
             behavior, but now persisted & typed as 'mentions')
     5. upsert graph_edges by (user_id, src, dst, type); set origin/confidence/
        evidence_memory_id/valid_from; invalidate edges whose evidence memory is
        now inactive/expired (valid_to = now(), active=false)
     6. write graph_build_audit row(s)
```

Steps 1–3 and 4a/4c are deterministic and cheap; only step 4b touches the LLM and it
degrades gracefully — the `ruleBasedExtraction`/`ruleBasedBriefing` precedent
(`llm-worker:51`). **The builder only ever writes the four graph tables**; it holds no
write path to `memory_records`/`entity_mentions` (the safety invariant, §10).

### 6.2 Entity resolution / canonicalization

Reuses the spine that already exists: `entity_mentions.lower(entity)` matching
(`021:24`, `032:94`). Two mentions that lowercase-match collapse to one node;
distinct surface forms ("Keerthana", "Keerthana Rao") are reconciled by the LLM
classifier into one `node_key` when confident, else kept separate and linked by a
low-confidence `mentions` edge (conservative: a missed merge is cheaper than a wrong
one). Where a cluster exists, the cluster's `cluster_key` is authoritative.

### 6.3 Idempotency

Every write is an **upsert keyed by a UNIQUE constraint** (`node_key`;
`(src,dst,type)`). Re-running a `graph_construction` job for the same `node_key`
produces the same nodes/edges (bumping `version`, refreshing attributes) — never
duplicates. A pending/processing job for the same `node_key` short-circuits
(the same guard `memory-extraction` already uses). Backfill is therefore safely
resumable.

---

## 7. Multi-hop typed retrieval

Generalizes `graph_expand_memories` from *untyped memory→memory co-mention* to
*typed node→edge→node traversal*. New RPC:

```sql
graph_traverse_typed(
  p_user_id      UUID,
  seed_node_ids  UUID[],
  edge_types     TEXT[]  DEFAULT NULL,   -- NULL = all types
  max_hops       INTEGER DEFAULT 2,
  max_results    INTEGER DEFAULT 25,
  min_confidence DOUBLE PRECISION DEFAULT 0.0,
  follow_reverse BOOLEAN DEFAULT TRUE    -- may walk edges against direction (decayed)
) RETURNS TABLE (
  node_id UUID, label TEXT, node_type TEXT,
  hops INTEGER, path_score DOUBLE PRECISION,
  path TEXT,                 -- "Keerthana Rao -works_on-> xConnect -blocked_by-> Versant email"
  terminal_edge_type TEXT,
  evidence_memory_id UUID
)
```

### 7.1 Seed selection

`retrieve-context` resolves the top-`GRAPH_SEED_COUNT` ranked **memories** (today it
uses the top-10 memory ids, `index.ts:166`) to their **nodes** via
`graph_node_members` (single indexed `memory_id` lookup), and also includes any
`graph_nodes` directly hit by centroid vector search against the query embedding. The
union (deduped) is the seed set — broader and *typed*, unlike the current
memory-only seeds.

### 7.2 Hop expansion with edge-type filters & path decay

```
TRAVERSE(seeds, edge_types, max_hops):
  frontier := { (n, hops=0, score=1.0, path=label(n)) for n in seeds }
  visited  := {}                                  # cycle handling: (node,edge_type) keys
  results  := []
  while frontier not empty and |results| < max_results:
     (n, h, s, p) := pop(frontier)
     if h >= max_hops: continue
     for e in active_edges(n, edge_types, valid_to IS NULL,
                           confidence >= min_confidence):     # outgoing
        m := e.dst ; dir_decay := 1.0
        # optionally also incoming edges with a penalty:
        # if follow_reverse: include e where e.dst=n -> m:=e.src, dir_decay:=REV_PENALTY
        key := (m.id, e.edge_type)
        if key in visited: continue                # break cycles on (node,edge_type)
        visited += key
        hop_decay := HOP_DECAY ^ (h+1)             # geometric per-hop attenuation
        edge_w    := EDGE_TYPE_WEIGHT[e.edge_type] # e.g. blocked_by=1.0, mentions=0.4
        s' := s * hop_decay * dir_decay * e.confidence * edge_w
        p' := p + " -" + e.edge_type + "-> " + label(m)
        results += (m, h+1, s', p', e.edge_type, e.evidence_memory_id)
        frontier += (m, h+1, s', p')
  return top-by-path_score(results, max_results)
```

**Scoring math.** A path's score is a decayed product along its edges:

```
path_score = Π_{i=1..h} ( HOP_DECAY^1 · dir_decay_i · confidence_i · EDGE_TYPE_WEIGHT(type_i) )

defaults:  HOP_DECAY = 0.6     REV_PENALTY = 0.7
           EDGE_TYPE_WEIGHT: blocked_by 1.0, depends_on 0.9, works_on 0.8,
                             assigned_to 0.8, signed 0.8, part_of 0.7,
                             owns 0.7, mentions 0.4
```

This subsumes the current hard-coded hop scores — today hop1=0.4, hop2+=0.25
(`index.ts:177`). Here a hop-1 `blocked_by` (0.6·1.0·conf) ≈ 0.6·conf and a hop-2
`mentions·mentions` (0.6²·0.4²) ≈ 0.06 — i.e. typed, confident, near edges dominate
distant generic ones, which the flat 0.4/0.25 scheme cannot express.

**Cycle handling:** `visited` keyed on `(node_id, edge_type)` so A→B→A via the same
relation is cut, while legitimately re-reaching a node by a *different* relation is
allowed once. `max_hops` (default 2, configurable up to ~4 for the Knowledge Engine)
and `max_results` are hard caps. **Cap discipline mirrors `graph_expand_memories`** —
`STABLE`, `SECURITY DEFINER`, `LIMIT max_results`.

### 7.3 SQL vs edge function

- **Bounded typed traversal (≤ ~3 hops, type-filtered)** → recursive CTE in the RPC
  (set-based, one round-trip, no per-hop network latency), exactly mirroring
  `graph_expand_memories`'s `WITH RECURSIVE reach(...)` shape
  (`032:87-112`) but joining `graph_edges` (type-filtered) instead of self-joining
  `entity_mentions`, and carrying `path`/`path_score` columns.
- **Adaptive / LLM-guided traversal** (e.g. the Knowledge Engine choosing which edge
  type to follow next based on the question) → orchestrated in the **edge function**,
  calling `graph_traverse_typed` per expansion step. Default retrieval uses the pure
  SQL path; only `036` opts into orchestration.

### 7.4 Worked example

```
seed (from query "what's blocking onboarding for Keerthana?"):
   person:keerthana rao        (resolved from top-ranked memory + centroid hit)

graph_edges (active):
   person:keerthana rao  --works_on(0.9,asserted)-->  project:xconnect
   project:xconnect      --blocked_by(0.95,asserted, evidence=Versant email mem)--> communication:versant email

graph_traverse_typed(seeds=[keerthana], edge_types=NULL, max_hops=2):
   hop1: xConnect       path_score = 0.6·1·0.9·0.8 (works_on)     ≈ 0.43
         path = "Keerthana Rao -works_on-> xConnect"
   hop2: Versant email  path_score = 0.43 · 0.6·1·0.95·1.0(blocked_by) ≈ 0.245
         path = "Keerthana Rao -works_on-> xConnect -blocked_by-> Versant email"
         evidence_memory_id = <the memory asserting the block>
```

The terminal node (Versant email) and its **path string** flow into ranking and
assembly — the system can now state *the relationship*, not just surface a co-mentioned
row.

---

## 8. Ranking integration

Keep `ranker.ts` weights **stable**; graph results enter as an **additive** signal
behind a flag, mirroring how Phase 15 temporal boost and Phase 16 graph expansion were
added without retuning `W_SEM … W_REINF` (`ranker.ts:54-58`).

1. **Graph items become ranked items.** Each traversal result is mapped to a candidate
   carrying its terminal node's memory/cluster fields (so `semantic`, `importance`,
   `recency`, `urgency` are computed as usual) **plus** a `graph_path_score` and
   `graph_expanded: true` (the existing flag `index.ts:177` uses).
2. **Per-hop decay is already in `graph_path_score`** (§7.2) — it replaces the flat
   `hybrid_score 0.4/0.25` mapping with the typed, decayed value. We feed it through
   the same `semanticScore` slot (`ranker.ts:70-74` reads `item.hybrid_score`), so no
   ranker code path changes for the base case.
3. **New additive graph-relevance term** (flagged, default 0 to ship neutral):
   ```
   W_GRAPH = 0.0   // default; raise to e.g. 0.10 once benchmarked
   finalScore += W_GRAPH * graph_path_score
   ```
   When `W_GRAPH = 0` the ranker is byte-for-byte today's behavior — the safe default.
   The benchmark (the `design_benchmark.ts`/50-case CI gate) is re-run before raising
   it; the other weights are not touched. (Optionally rebalance so weights still sum to
   1.0; the additive form is chosen so a regression can be reverted by zeroing one
   constant.)
4. **Edge-type → ranker hint:** a `blocked_by`/`depends_on` terminal can carry a small
   urgency nudge (it's an obstacle the user likely cares about) — implemented as a tiny
   addend inside `graph_path_score`, not a new weight, to keep the weight vector stable.

---

## 9. Context assembly integration

`assembler.ts` (sort by `finalScore` desc, `>= 0.3` threshold, source_hash/text-prefix
dedup, ~2000-word cap, one line per item) gains **one new format branch** for typed
paths, rendering *relationship statements* instead of bare rows:

```
[Relation] Keerthana Rao works on xConnect, which is blocked by the Versant email.
```

- The branch fires when an item has `graph_path` (the path string from §7) and renders
  it as a single line — denser than emitting each hop's memory separately, so **more
  distinct facts fit under the 2000-word cap** (`assembler.ts:1,28-55`).
- **Dedup with consolidation profiles:** a graph path terminal may coincide with a
  consolidation `[Profile - …]` object (033) for the same entity. The assembler dedups
  by reusing the existing `seenText`/`source_hash` sets — graph items carry a synthetic
  hash derived from `node_key + edge_type + dst node_key`, and a path whose terminal is
  already represented by a profile object is suppressed (profile wins; it's richer).
- **Token budget** is shared: paths are short statements (well under the per-item word
  cost of N raw memory lines), so the typed-path branch is net token-positive.

---

## 10. Failure handling

| Failure | Behavior |
|---|---|
| **LLM relation extraction down** (router returns `rule-engine` sentinel) | Construction runs the **rule pass only** (§6.1 step 4c): emit `origin='rule'`, `edge_type='mentions'` edges from `entity_mentions` co-occurrence. The graph degrades *exactly* to today's untyped co-mention behavior — no worse than `graph_expand_memories`. Job succeeds (not a failure). |
| **Partial graph / orphan nodes** | A node with members but no extracted typed edges still participates as a seed and via `mentions` edges. An edge whose `evidence_memory_id` was deleted → `ON DELETE SET NULL`, edge kept but flagged for re-evaluation on next sweep. Orphan edges (node soft-deleted) → `ON DELETE CASCADE` removes them. |
| **Edge invalidation** | When a source memory expires/deactivates (`active=false` or `expires_at` passed), the incremental/sweep job sets `valid_to=now()`, `active=false` on edges whose `evidence_memory_id` is that memory, and logs `edge_invalidated`. Traversal filters `valid_to IS NULL AND active` (§7.2), so stale relations vanish from retrieval without deletion. |
| **Traversal timeout** | `graph_traverse_typed` is bounded by `max_hops`/`max_results` and the recursive `LIMIT`. In `retrieve-context` the call is **best-effort, wrapped in try/catch** exactly like the current graph expansion (`index.ts:164-182`): on error/timeout it logs `graph_traversal_failed` and retrieval proceeds with hybrid + ranker results only. Never blocks the response. |
| **Telemetry** | Reuse the `retrieval_runs` / `retrieval_failures` pattern (`index.ts:225-255`). Add `graph_traversal` as a `stage` value in `retrieval_failures`, and per-run counters (seed nodes, paths returned, max hop reached) on `retrieval_runs` (additive columns *there*, or a sibling `retrieval_graph_events` table modeled on `retrieval_rank_events`). |
| **Circuit breaker interaction** | Construction's LLM calls go through `LLMRouter.execute()`; the breaker (`provider_health`, cooldowns) already protects them. When all providers are cooling down, construction takes the rule path — the breaker and the rule fallback compose without special-casing. Embedding for node centroids uses `generateEmbedding()` (must be 768-dim); on failure the node keeps its cluster centroid or skips direct vector retrievability (still reachable via members). |

---

## 11. Rollback strategy

Three tiers, all possible because the graph is a **derived projection** (§2).

### Tier 1 — Feature flags (instant, no data change)

Two independent env flags read by `retrieve-context` and `llm-worker`:

- `GRAPH_READ_ENABLED` — when off, the traversal stage is skipped and retrieval
  behaves **exactly as today** (it can even fall back to the existing
  `graph_expand_memories` call). First lever for any regression; no migration, instant
  via `supabase secrets set`.
- `GRAPH_WRITE_ENABLED` — gates the `graph_construction` job so we can stop *building*
  the graph while still *reading* the materialized one, or vice-versa.

`W_GRAPH = 0` (§8) is a third, finer lever: graph items are still retrieved/rendered
but contribute nothing to score — a "soft off".

### Tier 2 — Drop the layer (full reversal)

Because nodes/edges are a pure function of `memory_records` + `entity_mentions`
(+ `memory_clusters`): `TRUNCATE`/drop the four graph tables (a down-migration) and the
system is byte-for-byte back to pre-graph behavior. **No source data is at risk** — the
builder never mutated `memory_records`. Rebuild is a single resumable backfill job —
drop-and-rebuild is a supported, idempotent operation, not disaster recovery.

### Tier 3 — Surgical undo (per-edge / per-node)

`graph_build_audit` + per-row `version` + `valid_to`/`active` make targeted reversal
possible **without deletes**:

- Wrong inferred edge (LLM false positive) → `edge_invalidated` (`active=false`,
  `valid_to=now()`); it leaves traversal immediately; the underlying memory is untouched.
- Bad node merge → re-key/split, `node_merged` reversal from the audit `detail` snapshot.
- A whole bad build window → replay the audit log for that `last_built_at` window and
  deactivate affected rows.

**Safety invariant (enforce in code review):** the `graph_construction` worker must
only ever `INSERT`/`UPDATE`/soft-delete the **four graph tables**. It must hold **no
write path** to `memory_records` or `entity_mentions`. Any such write is a blocking
defect — it is what guarantees Tiers 1–2.

---

## 12. Migration plan — `034_knowledge_graph.sql`

**Additive-only. Zero ALTERs to `memory_records`/`entity_mentions`/`memory_clusters`.**

1. **Tables (`CREATE TABLE IF NOT EXISTS`):** `graph_nodes`, `graph_node_members`,
   `graph_edges`, `graph_build_audit` (§3). All FKs reference existing objects
   (`auth.users`, `memory_records`, `memory_clusters`) so the migration is safe under
   strict ordered `db reset`.
2. **RLS + policies:** `ENABLE ROW LEVEL SECURITY`; per-user `SELECT` policies with
   `DROP POLICY IF EXISTS` guards (idempotent). No write policies for `authenticated`.
3. **Indexes (`IF NOT EXISTS`):** per §3.5, including the ivfflat on `centroid`
   following the `vector(768)` + `vector_cosine_ops` + `lists=100` convention
   (mirrors `idx_memory_records_embedding`).
4. **RPCs (SECURITY DEFINER, service-role grant):**
   - `graph_traverse_typed(...)` (§7) — the recursive-CTE typed traversal.
   - `resolve_nodes_for_memories(p_user_id, memory_ids[])` — the seed lookup
     (memory→node), one round-trip (mirrors the collapse lookup in 033).
   - `hybrid_search_nodes(query_text, query_embedding, match_count)` — direct node
     centroid search (modeled on `hybrid_search_memories`, `032:19-57`).
   - `invalidate_edges_for_memories(p_user_id, memory_ids[])` — the soft-expiry writer.
   - Each `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role`,
     exactly like `graph_expand_memories` (`021:70-71`).
5. **No enum / `llm_jobs` migration:** `graph_construction` is a free-TEXT `job_type`.
6. **Backfill is NOT in the migration.** The migration creates **empty** tables (keeps
   `db reset` fast/deterministic). Population is a **separate resumable
   `graph_construction` job** with `scope:backfill` that pages over each user's
   `entity_mentions`/clusters, chunked to `MAX_JOBS_PER_RUN=5` and the 55s cron timeout,
   idempotent via the `node_key`/edge upserts, gated behind `GRAPH_WRITE_ENABLED`.
7. **CI / `db reset` safety:** purely additive, references only existing objects, fully
   idempotent. `deno check` must pass for the new `retrieve-context` traversal code and
   the worker's new dispatch branch (CI gates per `CLAUDE.md`). A `scripts/validate-*.sql`
   assertion can verify the rollback invariant indirectly (e.g. `memory_records` row
   count unchanged by a construction run).
8. **pg_cron sweep (optional, later migration `03x`):** schedules a periodic
   `graph_construction scope:sweep` enqueue **only if** Vault secrets `project_url` +
   `worker_secret` exist, else no-ops — the exact pattern of `022_schedule_llm_worker.sql`
   + `scripts/setup-worker.sql`, so `db reset` stays green.

---

## 13. Graph update strategy (summary)

| Trigger | When | Scope |
|---|---|---|
| **Incremental (event-driven)** | At the tail of `processMemoryExtraction` after it writes `entity_mentions` (`llm-worker:455-461`) — and after consolidation (033) materializes/updates a cluster | enqueue `graph_construction` scoped to each affected `node_key` |
| **Scheduled (sweep)** | pg_cron, low frequency (e.g. every 30 min), mirrors `llm-worker-drain` | re-extract edges where `last_built_at` is stale; invalidate edges of newly-expired memories; reconcile after cluster merges/splits |
| **Edge invalidation** | memory expires/deactivates, or a 033 cluster merge/split repoints nodes | `invalidate_edges_for_memories`; re-key nodes to surviving cluster; audited |

**Consolidation merges/splits (033 §6):** when two clusters merge, the build job
repoints both `graph_nodes.cluster_id` to the survivor, re-keys `node_key`, and merges
their edges (UNIQUE upsert dedups; conflicting confidences max-merged, audited
`node_merged`). A split mints a second node (`node_key#2`) and partitions edges by
evidence membership. The graph is always reconcilable from the cluster layer.

---

## 14. Testing plan

**Deterministic fixtures, no live LLM** (the `design_benchmark.ts` / 50-case CI-gate
precedent). The LLM relation extractor is stubbed to return fixed triples; the rule
fallback is exercised by forcing the `rule-engine` sentinel.

1. **Traversal RPC (`deno test` + SQL fixtures):**
   - Seed a fixed graph (Keerthana→xConnect→Versant) and assert
     `graph_traverse_typed` returns the expected nodes, `hops`, `path` strings, and
     **monotonically decreasing `path_score`** per hop (correctness of hop decay).
   - Edge-type filter: `edge_types=['blocked_by']` returns only the blocked path.
   - `min_confidence` and `valid_to` filtering: an invalidated edge is excluded.
   - **Cycle test:** A→B→A on the same edge_type terminates; A reachable by two
     different relations is emitted once per relation, capped.
   - `max_hops`/`max_results` caps respected; RLS — a second user's nodes never appear.
2. **Construction handler (`deno test`):**
   - **Idempotency:** running `graph_construction` twice for a `node_key` yields
     identical node/edge rows (version bumped, no duplicates) — assert UNIQUE upsert.
   - **Asserted vs inferred vs rule:** stubbed LLM → typed edges with
     `origin='inferred'`; sentinel → `origin='rule'`, `mentions` only; single-sentence
     predicate → `origin='asserted'`, `evidence_memory_id` set.
   - **Cluster linkage:** when a `memory_clusters` row exists, the node adopts its
     `cluster_id`/`centroid` (no duplicate identity).
   - **Edge invalidation:** deactivate a memory → its evidenced edges get
     `valid_to`/`active=false`.
3. **Ranking integration:** with `W_GRAPH=0`, `rankResults` output is **identical** to
   today for the same items (additive-neutral proof); with `W_GRAPH>0`, a high-score
   path edges up a candidate — assert the 50-case benchmark gate still passes.
4. **Assembler:** a `graph_path` item renders the `[Relation] …` statement; a path
   whose terminal coincides with a 033 `[Profile - …]` object is deduped (profile wins).
5. **Benchmark cases (extend `design_benchmark.ts`):** the Keerthana→xConnect→Versant
   example as a labeled multi-hop case; assert the Versant email surfaces *via the typed
   path* and is rendered as a relationship statement.
6. **Rollback / flag tests:** `GRAPH_READ_ENABLED=false` → retrieval output equals the
   pre-graph baseline; `GRAPH_WRITE_ENABLED=false` → construction job is a no-op;
   drop-tables → `retrieve-context` falls back cleanly (try/catch) with no error.
7. **`db reset` / CI:** migration applies on a clean DB; `deno check` green for new
   edge-function code; validate-SQL asserts `memory_records` row count is unchanged by a
   construction run (the rollback invariant).

---

## 15. Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Graph representation | **Separate typed node/edge tables (derived)** | new columns on `memory_records`; or extend `entity_mentions` with a `type` | Honors no-schema-churn at the source; typed edges need their own rows; trivially droppable. Cost: extra joins + a build pipeline. |
| Node identity | **Reuse 033 clusters as canonical nodes (`cluster_id` link)** | independent graph entity table | One identity for an entity across consolidation *and* graph; no drift. Cost: graph depends on the consolidation layer for best identity (degrades to entity-string nodes if absent). |
| Edge typing | **LLM relation extraction + asserted/rule passes** | pure co-occurrence (today) | Enables `Person→Project→Email` typed queries the Knowledge Engine needs. Cost: an LLM step (async, breaker-protected, rule fallback). |
| Traversal location | **Recursive CTE RPC for bounded hops; edge fn for adaptive** | all in edge function | Set-based SQL is one round-trip and mirrors `graph_expand_memories`. Cost: complex adaptive walks need orchestration. |
| Ranking | **Additive `W_GRAPH` flag, default 0** | retune `W_SEM…` for graph | Ships neutral; instantly revertible by zeroing one constant; existing benchmark stays valid. Cost: graph contributes nothing until tuned. |
| Edge lifecycle | **Soft-expiry (`valid_to`/`active`)** | hard delete on memory change | Keeps history/audit; traversal filters validity. Cost: tables grow; sweep must prune. |
| Build trigger | **Async `llm_jobs` job** | inline / DB trigger | LLM work must be async; triggers can't call LLMs in-txn. Cost: graph is eventually-consistent (seconds–minutes). |
| Fallback | **Degrade to `mentions` (today's co-mention)** | fail the build | The graph is never worse than the current `graph_expand_memories`. Cost: typed edges absent during outages. |

### Risks & mitigations

- **Hallucinated edges** (LLM invents `blocked_by`) → `confidence` + `min_confidence`
  filter; `origin='inferred'` ranked below `asserted`; surgical `edge_invalidated`
  undo; conservative default is *don't assert*.
- **Stale relationships** after a memory changes → incremental re-build of the touched
  `node_key`; sweep invalidates edges of expired memories.
- **Traversal blow-up** on dense graphs → `max_hops`/`max_results`/`min_confidence`
  caps, geometric decay starves long paths, best-effort try/catch never blocks
  retrieval.
- **Identity drift** vs consolidation → `cluster_id` link makes the cluster
  authoritative; merges/splits re-key nodes (audited).
- **Cost** of relation-extraction LLM calls → only on build/change, not per query;
  breaker + rule fallback cap spend.

---

## Appendix — end-to-end worked example

Existing `memory_records` (all retained, never mutated):

```
m1 [person]     Keerthana Rao is a collaborator on xConnect    entity_mentions: Keerthana Rao, xConnect
m2 [project]    xConnect is blocked by the Versant email        entity_mentions: xConnect, Versant
m3 [commitment] Keerthana Rao requested onboarding updates      entity_mentions: Keerthana Rao
```

After `graph_construction` (linking to 033 clusters where present):

```
graph_nodes:
  person:keerthana rao      label="Keerthana Rao"  cluster_id=<entity:keerthana rao>
  project:xconnect          label="xConnect"       cluster_id=<entity:xconnect>
  communication:versant     label="Versant email"  node_type=communication

graph_edges:
  person:keerthana rao --works_on(0.9,inferred, ev=m1)--> project:xconnect
  project:xconnect     --blocked_by(0.95,asserted, ev=m2)--> communication:versant
```

Query *"what's blocking onboarding for Keerthana?"*:

- **seed:** `person:keerthana rao` (from top-ranked memory m1/m3 + centroid hit)
- **`graph_traverse_typed(max_hops=2)`** →
  path `Keerthana Rao -works_on-> xConnect -blocked_by-> Versant email`,
  `path_score ≈ 0.245`, `evidence_memory_id = m2`.
- **ranker** scores the Versant-email terminal as a normal item (+ `W_GRAPH·0.245`).
- **assembler** renders:
  `[Relation] Keerthana Rao works on xConnect, which is blocked by the Versant email.`

The Personal Knowledge Engine (`036`) consumes this exact typed path to derive the
fact *"onboarding for Keerthana is blocked by the Versant email."* `m1..m3` remain
queryable individually; the entire graph layer is droppable and rebuildable at any time.

---

**File written:** `D:\cyrus v2\docs\superpowers\specs\2026-06-23-knowledge-graph-retrieval-design.md`
