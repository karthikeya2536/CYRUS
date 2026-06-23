# Retrieval Ranking Milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace vector-dominated retrieval ranking with a transparent weighted model (semantic + urgency + importance + recency + reinforcement), track retrieval reinforcement, add temporal-urgency, and gate it all with a measurable benchmark.

**Architecture:** Ranking stays in `ranker.ts` (out of SQL). A new migration adds `retrieval_count`, `last_retrieved_at`, `deadline_at` to `memory_records`, reshapes the two memory search RPCs to surface those signals, and adds a batched reinforcement-writer RPC. `retrieve-context` reinforces only memories that reach the final assembled context. The extractor derives `deadline_at` from the LLM's raw date before lifecycle grace is applied. A pure metrics module + deterministic fixture benchmark (Deno test) gates ranking quality in CI.

**Tech Stack:** Deno (edge functions), Postgres + pgvector (Supabase migrations), TypeScript (no Node libs in functions).

## Global Constraints

- Edge functions are **Deno**: full-URL imports, `Deno.env.get(...)`. No Node libraries.
- Migrations live in `supabase/migrations/`, are **strictly ordered** and **idempotent** (`ADD COLUMN IF NOT EXISTS`, `DROP FUNCTION IF EXISTS` before a return-shape change); a clean `supabase db reset` is the CI gate and must stay green.
- RLS everywhere: service-role functions filter by `user_id` explicitly.
- `generateEmbedding()` must stay 768-dim; do not touch it.
- `last_retrieved_at` is **stored but NOT a scoring signal in V1** (observability/decay only). Only `retrieval_count` feeds the formula.
- `record_memory_retrievals` must be a **single batched UPDATE**, never a per-id loop.
- Weights are **named constants** in `ranker.ts` and **sum to 1.0**: `W_SEM 0.50, W_URG 0.20, W_IMP 0.15, W_REC 0.10, W_REINF 0.05`.
- Reinforcement applies to **memory rows only** (emails/events have no such columns).
- Don't change `verify_jwt` flags in `config.toml`.

---

### Task 1: Migration — ranking-signal columns, RPC reshape, reinforcement writer

**Files:**
- Create: `supabase/migrations/032_retrieval_ranking_signals.sql`
- Test: `supabase db reset` + inline verification SQL (below)

**Interfaces:**
- Produces (consumed by Tasks 3 & 4):
  - `hybrid_search_memories(query_text TEXT, query_embedding vector(768), match_count INTEGER)` now also returns columns `llm_importance NUMERIC, system_importance NUMERIC, retrieval_count INTEGER, last_retrieved_at TIMESTAMPTZ, deadline_at TIMESTAMPTZ`.
  - `graph_expand_memories(p_user_id UUID, seed_ids UUID[], max_hops INTEGER, max_results INTEGER)` now also returns those same 5 columns (plus existing `hops`).
  - `record_memory_retrievals(p_user_id UUID, ids UUID[]) RETURNS void` — service-role only.
  - New columns on `memory_records`: `retrieval_count INTEGER NOT NULL DEFAULT 0`, `last_retrieved_at TIMESTAMPTZ`, `deadline_at TIMESTAMPTZ`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/032_retrieval_ranking_signals.sql`:

```sql
-- ============================================
-- Migration: 032_retrieval_ranking_signals
-- ============================================
-- Adds ranking signals used by retrieve-context/ranker.ts:
--   reinforcement (retrieval_count, last_retrieved_at),
--   temporal urgency (deadline_at),
-- surfaces importance + these signals from the memory search RPCs, and adds a
-- batched reinforcement writer. Idempotent; a clean `supabase db reset` stays green.
-- last_retrieved_at is stored for observability only (not a V1 scoring signal).
-- ============================================

ALTER TABLE public.memory_records ADD COLUMN IF NOT EXISTS retrieval_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.memory_records ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;
ALTER TABLE public.memory_records ADD COLUMN IF NOT EXISTS deadline_at       TIMESTAMPTZ;

-- ---- Primary semantic search: surface importance + ranking signals. ----
-- Return shape changes, so DROP before CREATE (CREATE OR REPLACE cannot alter OUT cols).
DROP FUNCTION IF EXISTS public.hybrid_search_memories(TEXT, vector, INTEGER);
CREATE FUNCTION public.hybrid_search_memories(
  query_text TEXT,
  query_embedding vector(768),
  match_count INTEGER DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  user_id UUID,
  category TEXT,
  memory_key TEXT,
  created_at TIMESTAMPTZ,
  similarity_distance FLOAT,
  llm_importance NUMERIC,
  system_importance NUMERIC,
  retrieval_count INTEGER,
  last_retrieved_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at,
    m.embedding <=> query_embedding AS similarity_distance,
    m.llm_importance, m.system_importance,
    m.retrieval_count, m.last_retrieved_at, m.deadline_at
  FROM public.memory_records m
  WHERE m.user_id = auth.uid()
    AND m.active = TRUE
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_memories(TEXT, vector, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_memories TO authenticated;

-- ---- Graph expansion: surface the same signals. ----
DROP FUNCTION IF EXISTS public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER);
CREATE FUNCTION public.graph_expand_memories(
  p_user_id UUID,
  seed_ids UUID[],
  max_hops INTEGER DEFAULT 2,
  max_results INTEGER DEFAULT 25
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  user_id UUID,
  category TEXT,
  memory_key TEXT,
  created_at TIMESTAMPTZ,
  hops INTEGER,
  llm_importance NUMERIC,
  system_importance NUMERIC,
  retrieval_count INTEGER,
  last_retrieved_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  WITH RECURSIVE reach(mid, hops) AS (
    SELECT s, 0 FROM unnest(seed_ids) AS s
    UNION
    SELECT em2.memory_id, r.hops + 1
    FROM reach r
    JOIN public.entity_mentions em1 ON em1.memory_id = r.mid AND em1.user_id = p_user_id
    JOIN public.entity_mentions em2
      ON lower(em2.entity) = lower(em1.entity)
     AND em2.user_id = p_user_id
     AND em2.memory_id <> r.mid
    WHERE r.hops < max_hops
  )
  SELECT m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at,
         MIN(r.hops) AS hops,
         m.llm_importance, m.system_importance,
         m.retrieval_count, m.last_retrieved_at, m.deadline_at
  FROM reach r
  JOIN public.memory_records m ON m.id = r.mid AND m.user_id = p_user_id AND m.active = TRUE
  WHERE r.mid <> ALL (seed_ids)
    AND (m.expires_at IS NULL OR m.expires_at > now())
  GROUP BY m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at,
           m.llm_importance, m.system_importance, m.retrieval_count,
           m.last_retrieved_at, m.deadline_at
  ORDER BY MIN(r.hops), m.created_at DESC
  LIMIT max_results;
$$;
REVOKE EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) TO service_role;

-- ---- Batched reinforcement writer (single UPDATE; user-scoped). ----
CREATE OR REPLACE FUNCTION public.record_memory_retrievals(p_user_id UUID, ids UUID[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  UPDATE public.memory_records
  SET retrieval_count = retrieval_count + 1,
      last_retrieved_at = now()
  WHERE id = ANY(ids) AND user_id = p_user_id;
$$;
REVOKE EXECUTE ON FUNCTION public.record_memory_retrievals(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_memory_retrievals(UUID, UUID[]) TO service_role;

-- ============================================
-- ROLLBACK: drop deadline_at/retrieval_count/last_retrieved_at columns and
-- re-apply migration 031 bodies of the two search functions; drop record_memory_retrievals.
-- ============================================
```

- [ ] **Step 2: Apply and verify the reset is green**

Run: `supabase db reset`
Expected: completes without error (all migrations re-apply cleanly).

- [ ] **Step 3: Verify columns and function shapes**

Run:
```bash
psql -h localhost -p 54322 -U postgres -d postgres -c "\d+ public.memory_records" \
  | grep -E "retrieval_count|last_retrieved_at|deadline_at"
psql -h localhost -p 54322 -U postgres -d postgres -c \
  "SELECT proname FROM pg_proc WHERE proname IN ('record_memory_retrievals','hybrid_search_memories','graph_expand_memories');"
```
Expected: the three columns are listed; all three function names returned.

- [ ] **Step 4: Check validation scripts don't assert the old RPC shape**

Run: `grep -rn "hybrid_search_memories\|graph_expand_memories" scripts/validate-*.sql`
If any script asserts a fixed column list/count for these functions, update it to the new shape. If they only check existence by name, no change needed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/032_retrieval_ranking_signals.sql scripts/validate-*.sql
git commit -m "feat(db): add retrieval ranking signals + reinforcement writer (migration 032)"
```

---

### Task 2: Pure ranking-metrics module

**Files:**
- Create: `supabase/functions/retrieve-context/eval/metrics.ts`
- Test: `supabase/functions/retrieve-context/eval/metrics.test.ts`

**Interfaces:**
- Produces (consumed by Task 6):
  - `recallAtK(ranked: string[], relevant: Set<string>, k: number): number`
  - `mrr(ranked: string[], relevant: Set<string>): number`
  - `ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number`
  - `ranked` = result ids best-first; `relevant` = set of relevant ids.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/retrieve-context/eval/metrics.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recallAtK, mrr, ndcgAtK } from "./metrics.ts";

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-4;

Deno.test("recallAtK counts relevant hits in top-k over total relevant", () => {
  // top2 = [a,b]; relevant = {a,c}; 1 hit / 2 relevant = 0.5
  assertEquals(recallAtK(["a", "b", "c"], new Set(["a", "c"]), 2), 0.5);
  // all relevant found
  assertEquals(recallAtK(["a", "c"], new Set(["a", "c"]), 5), 1);
  // empty relevant -> 0 (no division by zero)
  assertEquals(recallAtK(["a"], new Set<string>(), 5), 0);
});

Deno.test("mrr is reciprocal rank of first relevant hit", () => {
  assertEquals(mrr(["x", "a"], new Set(["a"])), 0.5);   // first hit at rank 2
  assertEquals(mrr(["a", "x"], new Set(["a"])), 1);     // first hit at rank 1
  assertEquals(mrr(["x", "y"], new Set(["a"])), 0);     // no hit
});

Deno.test("ndcgAtK normalizes DCG by ideal DCG", () => {
  // relevant={b}; b at index1 -> dcg=1/log2(3)=0.63093; idcg(1 relevant)=1/log2(2)=1
  if (!approx(ndcgAtK(["a", "b"], new Set(["b"]), 2), 0.63093)) throw new Error("ndcg single");
  // perfect ordering -> 1.0
  if (!approx(ndcgAtK(["a", "b"], new Set(["a", "b"]), 2), 1)) throw new Error("ndcg perfect");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read supabase/functions/retrieve-context/eval/metrics.test.ts`
Expected: FAIL — `Module not found "./metrics.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `supabase/functions/retrieve-context/eval/metrics.ts`:

```ts
// Pure ranking-quality metrics. No deps, no clock, no I/O.
// `ranked`: result ids ordered best-first. `relevant`: set of relevant ids.

export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

export function mrr(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  const limit = Math.min(k, ranked.length);
  for (let i = 0; i < limit; i++) {
    if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(k, relevant.size);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read supabase/functions/retrieve-context/eval/metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/retrieve-context/eval/metrics.ts supabase/functions/retrieve-context/eval/metrics.test.ts
git commit -m "feat(eval): pure ranking metrics (recall@k, mrr, ndcg@k)"
```

---

### Task 3: Weighted scoring engine in `ranker.ts`

**Files:**
- Modify: `supabase/functions/retrieve-context/ranker.ts` (rewrite `rankResults`; add signal helpers; keep `calculateRecencyScore`, `calculateEntityScore`, `calculateTemporalBoost` intact)
- Test: `supabase/functions/retrieve-context/ranking.test.ts`

**Interfaces:**
- Consumes: candidate objects with optional fields `hybrid_score`, `similarity_distance`, `llm_importance`, `system_importance`, `retrieval_count`, `created_at`, `received_at`, `start_time`, `deadline_at` (from Task 1's RPCs).
- Produces (consumed by Task 4 & 6):
  - `rankResults(items: any[], intent: string, entities: string[], temporal?: TemporalHint | null, nowMs?: number): any[]` — each item gets `finalScore: number` and `_scores` `{semantic, importance, recency, reinforcement, urgency, temporal_boost, final}`.
  - Exported helpers: `semanticScore(item)`, `importanceScore(item)`, `recencyScore(dateString, nowMs)`, `reinforcementScore(item)`, `urgencyScore(dateString, nowMs)`, plus constants `W_SEM, W_URG, W_IMP, W_REC, W_REINF, RECENCY_HALFLIFE_DAYS, REINF_CAP`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/retrieve-context/ranking.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  rankResults, urgencyScore, reinforcementScore, importanceScore, recencyScore,
  W_SEM, W_URG, W_IMP, W_REC, W_REINF,
} from "./ranker.ts";

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-3;
const JUNE23 = new Date("2026-06-23T00:00:00Z").getTime();

Deno.test("urgencyScore piecewise upcoming buckets", () => {
  const day = 86400000;
  assertEquals(urgencyScore(new Date(JUNE23 + 40 * day).toISOString(), JUNE23), 0.0); // >30
  assertEquals(urgencyScore(new Date(JUNE23 + 17 * day).toISOString(), JUNE23), 0.2); // 30>=d>14
  assertEquals(urgencyScore(new Date(JUNE23 + 10 * day).toISOString(), JUNE23), 0.4); // 14>=d>7
  assertEquals(urgencyScore(new Date(JUNE23 + 5 * day).toISOString(), JUNE23), 0.7);  // 7>=d>3
  assertEquals(urgencyScore(new Date(JUNE23 + 2 * day).toISOString(), JUNE23), 1.0);  // 3>=d>=0
});

Deno.test("urgencyScore piecewise overdue buckets", () => {
  const day = 86400000;
  assertEquals(urgencyScore(new Date(JUNE23 - 1 * day).toISOString(), JUNE23), 1.0); // 0..2 late
  assertEquals(urgencyScore(new Date(JUNE23 - 5 * day).toISOString(), JUNE23), 0.5); // 2..7 late
  assertEquals(urgencyScore(new Date(JUNE23 - 9 * day).toISOString(), JUNE23), 0.0); // >7 late
  assertEquals(urgencyScore(null, JUNE23), 0);                                       // no deadline
});

Deno.test("reinforcementScore saturates and clamps", () => {
  assertEquals(reinforcementScore({ retrieval_count: 0 }), 0);
  assertEquals(reinforcementScore({}), 0);
  const a = reinforcementScore({ retrieval_count: 2 });
  const b = reinforcementScore({ retrieval_count: 20 });
  if (!(b > a && b <= 1)) throw new Error("expected saturating growth <= 1");
});

Deno.test("importanceScore defaults to 0.5 when absent, else max of the two", () => {
  assertEquals(importanceScore({}), 0.5);
  assertEquals(importanceScore({ llm_importance: 0.9, system_importance: 0.3 }), 0.9);
});

Deno.test("recencyScore decays from 1.0 and treats future as 1.0", () => {
  assertEquals(recencyScore(new Date(JUNE23 + 86400000).toISOString(), JUNE23), 1.0); // future
  if (!(recencyScore(new Date(JUNE23 - 86400000 * 60).toISOString(), JUNE23) < 0.5)) {
    throw new Error("60-day-old item should decay below 0.5");
  }
});

Deno.test("rankResults: urgent low-semantic memory can beat high-semantic non-urgent", () => {
  const day = 86400000;
  const urgent = { id: "A", similarity_distance: 0.55, deadline_at: new Date(JUNE23 + 1 * day).toISOString() }; // sem .45, urg 1.0
  const similar = { id: "B", similarity_distance: 0.18 }; // sem .82, urg 0
  const [ra, rb] = rankResults([urgent, similar], "general", [], null, JUNE23);
  // both get the .15*0.5 default-importance term, so it cancels in the compare:
  // A = .50*.45 + .20*1.0 + .075 = .500 ; B = .50*.82 + .075 = .485  -> A wins
  if (!(ra.finalScore > rb.finalScore)) throw new Error("urgent item should outrank");
  assertEquals(ra._scores.urgency, 1.0);
});

Deno.test("rankResults: weights sum to 1.0", () => {
  if (!approx(W_SEM + W_URG + W_IMP + W_REC + W_REINF, 1.0)) throw new Error("weights must sum to 1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-net supabase/functions/retrieve-context/ranking.test.ts`
Expected: FAIL — `urgencyScore`/exports not found.

- [ ] **Step 3: Replace `rankResults` and add helpers**

In `supabase/functions/retrieve-context/ranker.ts`, keep `calculateRecencyScore`, `calculateEntityScore`, the `import { type TemporalHint, itemTimestamp }` line, and `calculateTemporalBoost` unchanged. **Replace the entire `rankResults` function** (the `export function rankResults(...) { ... }` block) with the following, and add the helpers/constants directly above it:

```ts
// ---- Phase A weighted scoring. Weights are tunable named constants; they sum
// to 1.0 (true weights, not relative coefficients). Re-run the benchmark after
// changing any of them. ----
export const W_SEM = 0.50;
export const W_URG = 0.20;
export const W_IMP = 0.15;
export const W_REC = 0.10;
export const W_REINF = 0.05;

export const RECENCY_HALFLIFE_DAYS = 30;
export const REINF_CAP = 50;

const DAY_MS = 86400000;

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function semanticScore(item: any): number {
  const base = item.hybrid_score ??
    (item.similarity_distance !== undefined ? 1 - item.similarity_distance : 0);
  return clamp01(base);
}

export function importanceScore(item: any): number {
  const hasImp = item.llm_importance != null || item.system_importance != null;
  if (!hasImp) return 0.5; // emails/events have no importance signal
  return clamp01(Math.max(item.llm_importance ?? 0, item.system_importance ?? 0));
}

// memory -> created_at, email -> received_at, event -> start_time
function recencySource(item: any): string | null {
  return item.created_at ?? item.received_at ?? item.start_time ?? null;
}

export function recencyScore(dateString: string | null, nowMs: number): number {
  if (!dateString) return 0;
  const t = new Date(dateString).getTime();
  if (Number.isNaN(t)) return 0;
  const ageDays = (nowMs - t) / DAY_MS;
  if (ageDays <= 0) return 1.0; // now/future
  return clamp01(Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS));
}

export function reinforcementScore(item: any): number {
  const count = typeof item.retrieval_count === "number" ? item.retrieval_count : 0;
  if (count <= 0) return 0;
  return clamp01(Math.log1p(count) / Math.log1p(REINF_CAP));
}

// memory -> deadline_at, event -> start_time; emails have neither
function deadlineSource(item: any): string | null {
  return item.deadline_at ?? item.start_time ?? null;
}

// Piecewise urgency curve (explainable buckets). d = days until deadline.
export function urgencyScore(dateString: string | null, nowMs: number): number {
  if (!dateString) return 0;
  const t = new Date(dateString).getTime();
  if (Number.isNaN(t)) return 0;
  const d = (t - nowMs) / DAY_MS;
  if (d >= 0) {
    if (d > 30) return 0.0;
    if (d > 14) return 0.2;
    if (d > 7) return 0.4;
    if (d > 3) return 0.7;
    return 1.0; // 3 >= d >= 0
  }
  const late = -d;
  if (late <= 2) return 1.0;
  if (late <= 7) return 0.5;
  return 0.0;
}

const r3 = (x: number) => parseFloat(x.toFixed(3));

export function rankResults(
  items: any[],
  intent: string,
  entities: string[],
  temporal: TemporalHint | null = null,
  nowMs: number = Date.now(),
) {
  return items.map((item) => {
    const semantic = semanticScore(item);
    const importance = importanceScore(item);
    const recency = recencyScore(recencySource(item), nowMs);
    const reinforcement = reinforcementScore(item);
    const urgency = urgencyScore(deadlineSource(item), nowMs);
    const temporalBoost = calculateTemporalBoost(item, temporal, nowMs);

    const finalScore =
      W_SEM * semantic +
      W_URG * urgency +
      W_IMP * importance +
      W_REC * recency +
      W_REINF * reinforcement +
      temporalBoost;

    return {
      ...item,
      finalScore,
      _scores: {
        semantic: r3(semantic),
        importance: r3(importance),
        recency: r3(recency),
        reinforcement: r3(reinforcement),
        urgency: r3(urgency),
        temporal_boost: r3(temporalBoost),
        final: r3(finalScore),
      },
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-net supabase/functions/retrieve-context/ranking.test.ts`
Expected: PASS (7 tests). Also run the existing temporal suite to confirm no regression:
Run: `deno test --allow-read --allow-net supabase/functions/retrieve-context/temporal.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check the function**

Run: `deno check supabase/functions/retrieve-context/index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/retrieve-context/ranker.ts supabase/functions/retrieve-context/ranking.test.ts
git commit -m "feat(rank): weighted scoring (semantic+urgency+importance+recency+reinforcement)"
```

---

### Task 4: Reinforcement write path in `retrieve-context`

**Files:**
- Modify: `supabase/functions/retrieve-context/index.ts` (after the `assembleContext` call, ~line 187)

**Interfaces:**
- Consumes: `assembled.context` items `{ id, text, score, source }` from `assembler.ts`; `record_memory_retrievals(p_user_id, ids)` from Task 1; `supabaseAdmin`, `user`, `log` already in scope.
- Produces: side-effect only (reinforces final-context memories). No new exports.

- [ ] **Step 1: Add the reinforcement call**

In `supabase/functions/retrieve-context/index.ts`, immediately **after** the line:

```ts
    const assembled = assembleContext(allRanked, 2000, 0.3); // Drop below 0.3 score
```

insert:

```ts
    // Phase B: reinforce ONLY memories that reached the final assembled context
    // (the rows actually sent to the LLM) — not every above-threshold candidate.
    // Single batched UPDATE via RPC; fire-and-forget so query latency is unchanged.
    try {
      const reinforcedIds = assembled.context
        .filter((c: any) => c.source === "memory")
        .map((c: any) => c.id)
        .filter(Boolean);
      if (reinforcedIds.length) {
        const p = supabaseAdmin.rpc("record_memory_retrievals", {
          p_user_id: user.id,
          ids: reinforcedIds,
        });
        const rt = (globalThis as any).EdgeRuntime;
        if (rt && typeof rt.waitUntil === "function") {
          rt.waitUntil(Promise.resolve(p).catch(() => {}));
        } else {
          await Promise.resolve(p).catch(() => {});
        }
      }
    } catch (_e) {
      log.warn("reinforcement_write_failed");
    }
```

- [ ] **Step 2: Type-check**

Run: `deno check supabase/functions/retrieve-context/index.ts`
Expected: no errors.

- [ ] **Step 3: Manual smoke against local stack (optional but recommended)**

With `supabase start` running and a seeded user, invoke `retrieve-context` once, then:
```bash
psql -h localhost -p 54322 -U postgres -d postgres -c \
  "SELECT id, retrieval_count, last_retrieved_at FROM memory_records WHERE retrieval_count > 0;"
```
Expected: rows that appeared in the assembled context show `retrieval_count >= 1` and a recent `last_retrieved_at`. If no local data, skip — Task 6 covers ranking correctness deterministically.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/retrieve-context/index.ts
git commit -m "feat(rank): reinforce only final-context memories via batched RPC"
```

---

### Task 5: Extractor populates `deadline_at`

**Files:**
- Modify: `supabase/functions/llm-worker/index.ts` (add `computeDeadlineAt` next to `computeExpiresAt` ~line 79; set `deadline_at` in the insert ~line 415 and in the merge-update paths ~line 314 and ~line 375)

**Interfaces:**
- Consumes: `mem` (extractor output with `category`, raw `expires_at`), `eventById` map, both already passed to `computeExpiresAt`.
- Produces: `computeDeadlineAt(mem, eventById): string | null`; `memory_records.deadline_at` populated on insert/merge. No prompt change — `deadline_at` is the LLM's raw date **before** the lifecycle grace that `computeExpiresAt` adds, guaranteeing `expires_at >= deadline_at`.

- [ ] **Step 1: Add `computeDeadlineAt` helper**

In `supabase/functions/llm-worker/index.ts`, immediately **after** the closing `}` of `computeExpiresAt` (the `return null; }` ending that function, ~line 79), add:

```ts
// Raw, pre-grace deadline used purely as a ranking signal (urgency). Distinct
// from expires_at (lifecycle). For time-bound categories this is the LLM's /
// calendar's actual date; expires_at is always >= this (grace added in
// computeExpiresAt), so a deadline memory is never lifecycle-expired early.
function computeDeadlineAt(mem: any, eventById: Map<string, any>): string | null {
  const category = String(mem.category || "").toLowerCase();
  if (category === "event" || category === "meeting") {
    const ev = mem.source_id ? eventById.get(String(mem.source_id)) : null;
    if (ev) return ev.start_time || ev.end_time || null;
    const d = mem.expires_at ? new Date(mem.expires_at) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (category === "deadline") {
    const d = mem.expires_at ? new Date(mem.expires_at) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}
```

- [ ] **Step 2: Compute it where `finalExpiresAt` is computed**

Run: `grep -n "finalExpiresAt =" supabase/functions/llm-worker/index.ts`
On the line immediately **after** the `finalExpiresAt = ...` assignment (inside `processMemoryExtraction`, before the dedup/insert logic), add:

```ts
    const finalDeadlineAt = computeDeadlineAt(mem, eventById);
```

(If `eventById` is named differently in that scope, use the same map variable passed to the adjacent `computeExpiresAt(mem, ...)` call.)

- [ ] **Step 3: Set `deadline_at` on insert**

In the `supabaseAdmin.from("memory_records").insert({ ... })` object (~line 415), immediately **after** the `expires_at: finalExpiresAt,` line, add:

```ts
            deadline_at: finalDeadlineAt,
```

- [ ] **Step 4: Set `deadline_at` on the merge-update paths**

Run: `grep -n "last_seen_at: new Date().toISOString()" supabase/functions/llm-worker/index.ts`
For each `memory_records").update({ ... })` block that sets `last_seen_at` (~line 314 and ~line 375), add inside that update object:

```ts
            deadline_at: finalDeadlineAt,
```

- [ ] **Step 5: Type-check**

Run: `deno check supabase/functions/llm-worker/index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/llm-worker/index.ts
git commit -m "feat(extract): derive deadline_at (pre-grace) for time-bound memories"
```

---

### Task 6: Deterministic benchmark fixtures + CI gate

**Files:**
- Create: `supabase/functions/retrieve-context/eval/fixtures/cases.json`
- Create: `supabase/functions/retrieve-context/eval/benchmark.test.ts`

**Interfaces:**
- Consumes: `rankResults` (Task 3), `recallAtK/mrr/ndcgAtK` (Task 2).
- Fixture shape (one array of cases):
  ```ts
  type Case = {
    id: string;            // unique case id
    kind: "retrieval" | "ranking" | "urgency";
    query: string;         // human-readable; not scored, for documentation
    nowMs?: number;        // epoch ms; required for urgency cases (deterministic clock)
    candidates: any[];     // raw items with id + signal fields (passed to rankResults)
    relevant: string[];    // ids that should rank near the top
  };
  ```
- Produces: a CI Deno test asserting averaged Recall@5/@10, MRR, NDCG@10 over all cases meet baseline thresholds.

- [ ] **Step 1: Write the benchmark harness (failing — no fixtures yet)**

Create `supabase/functions/retrieve-context/eval/benchmark.test.ts`:

```ts
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rankResults } from "../ranker.ts";
import { recallAtK, mrr, ndcgAtK } from "./metrics.ts";

type Case = {
  id: string;
  kind: "retrieval" | "ranking" | "urgency";
  query: string;
  nowMs?: number;
  candidates: any[];
  relevant: string[];
};

// Baseline thresholds. Ratchet upward as the model improves; never lower silently.
const THRESHOLDS = { recall5: 0.70, recall10: 0.85, mrr: 0.60, ndcg10: 0.70 };

const cases: Case[] = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/cases.json", import.meta.url)),
);

Deno.test("benchmark: fixture corpus shape", () => {
  assert(cases.length >= 50, `expected >= 50 cases, got ${cases.length}`);
  const by = (k: string) => cases.filter((c) => c.kind === k).length;
  assert(by("retrieval") >= 20, "need >= 20 retrieval cases");
  assert(by("ranking") >= 20, "need >= 20 ranking cases");
  assert(by("urgency") >= 10, "need >= 10 urgency cases");
});

Deno.test("benchmark: averaged metrics meet baseline thresholds", () => {
  let r5 = 0, r10 = 0, m = 0, n10 = 0;
  for (const c of cases) {
    const ranked = rankResults(c.candidates, "general", [], null, c.nowMs ?? Date.now())
      .sort((a: any, b: any) => b.finalScore - a.finalScore)
      .map((x: any) => x.id as string);
    const rel = new Set(c.relevant);
    r5 += recallAtK(ranked, rel, 5);
    r10 += recallAtK(ranked, rel, 10);
    m += mrr(ranked, rel);
    n10 += ndcgAtK(ranked, rel, 10);
  }
  const N = cases.length;
  const avg = { recall5: r5 / N, recall10: r10 / N, mrr: m / N, ndcg10: n10 / N };
  console.log("benchmark metrics:", avg);
  assert(avg.recall5 >= THRESHOLDS.recall5, `recall@5 ${avg.recall5} < ${THRESHOLDS.recall5}`);
  assert(avg.recall10 >= THRESHOLDS.recall10, `recall@10 ${avg.recall10} < ${THRESHOLDS.recall10}`);
  assert(avg.mrr >= THRESHOLDS.mrr, `mrr ${avg.mrr} < ${THRESHOLDS.mrr}`);
  assert(avg.ndcg10 >= THRESHOLDS.ndcg10, `ndcg@10 ${avg.ndcg10} < ${THRESHOLDS.ndcg10}`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno test --allow-read supabase/functions/retrieve-context/eval/benchmark.test.ts`
Expected: FAIL — fixtures file missing / fewer than 50 cases.

- [ ] **Step 3: Seed `cases.json` with the canonical patterns**

Create `supabase/functions/retrieve-context/eval/fixtures/cases.json`. Start with these 5 fully-worked cases. Note `1750636800000` = `2026-06-23T00:00:00Z`; deadlines below are offsets from it.

```json
[
  {
    "id": "rank-focus-today",
    "kind": "ranking",
    "query": "what should I focus on today?",
    "nowMs": 1750636800000,
    "candidates": [
      { "id": "A", "similarity_distance": 0.55, "deadline_at": "2026-06-24T00:00:00Z" },
      { "id": "B", "similarity_distance": 0.18 },
      { "id": "C", "similarity_distance": 0.39, "llm_importance": 0.9, "system_importance": 0.9 }
    ],
    "relevant": ["A", "C"]
  },
  {
    "id": "rank-urgent-beats-similar",
    "kind": "ranking",
    "query": "anything due soon I should not miss?",
    "nowMs": 1750636800000,
    "candidates": [
      { "id": "U", "similarity_distance": 0.50, "deadline_at": "2026-06-25T00:00:00Z" },
      { "id": "S", "similarity_distance": 0.10 }
    ],
    "relevant": ["U"]
  },
  {
    "id": "urgency-udemy-july10",
    "kind": "urgency",
    "query": "udemy deadline",
    "nowMs": 1750636800000,
    "candidates": [
      { "id": "udemy", "similarity_distance": 0.55, "deadline_at": "2026-07-10T00:00:00Z" },
      { "id": "noise", "similarity_distance": 0.20 }
    ],
    "relevant": ["udemy"]
  },
  {
    "id": "retrieval-recruiter",
    "kind": "retrieval",
    "query": "which recruiter contacted me?",
    "candidates": [
      { "id": "rec", "similarity_distance": 0.22, "llm_importance": 0.8 },
      { "id": "x1", "similarity_distance": 0.70 },
      { "id": "x2", "similarity_distance": 0.81 }
    ],
    "relevant": ["rec"]
  },
  {
    "id": "rank-reinforced-collaborator",
    "kind": "ranking",
    "query": "who am I working with on the project?",
    "candidates": [
      { "id": "collab", "similarity_distance": 0.40, "retrieval_count": 20, "llm_importance": 0.7 },
      { "id": "oneoff", "similarity_distance": 0.35, "retrieval_count": 1 }
    ],
    "relevant": ["collab"]
  }
]
```

- [ ] **Step 4: Expand to 50 cases following the shown pattern**

Author additional cases in the same file until counts reach **20 retrieval, 20 ranking, 10 urgency** (50 total). Rules, applied to every case you add:
- Each case lists `candidates` (5–12 items typical) with explicit signal fields and a unique `id`, plus the `relevant` id set.
- **Ranking cases must be adversarial** — signals must *conflict* so the correct order depends on weight interaction (e.g. high-semantic-but-stale vs mid-semantic-but-urgent; high-importance recruiter vs higher-semantic spam; reinforced collaborator vs one-off application). Trivial "query word appears in memory" cases belong in `retrieval`, not `ranking`.
- **Urgency cases must set `nowMs`** and vary the deadline across buckets (>30d → 0, 14–30d → 0.2, 7–14d → 0.4, 3–7d → 0.7, ≤3d → 1.0, and overdue 0–2d/2–7d/>7d) so the piecewise curve is exercised end to end.
- Keep ids unique within a case; reuse across cases is fine.
- **Determinism:** any case whose candidates carry a `created_at` / `received_at` / `start_time` (i.e. a recency signal) MUST also set `nowMs`, otherwise `recencyScore` reads the wall clock and the benchmark becomes flaky. Cases with no timestamps need no `nowMs`.

- [ ] **Step 5: Run the benchmark to verify it passes**

Run: `deno test --allow-read supabase/functions/retrieve-context/eval/benchmark.test.ts`
Expected: PASS (2 tests); the metrics line prints averaged Recall@5/@10, MRR, NDCG@10 ≥ thresholds. If a metric is below threshold, that is a real signal — inspect the failing cases' `_scores` and either fix a genuine ranking bug or, if a fixture's `relevant` set was wrong, correct the fixture. Do **not** lower thresholds to force a pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/retrieve-context/eval/fixtures/cases.json supabase/functions/retrieve-context/eval/benchmark.test.ts
git commit -m "feat(eval): 50-case deterministic ranking benchmark (CI gate)"
```

---

### Task 7: Optional manual end-to-end harness + final checks

**Files:**
- Create: `scripts/benchmark-retrieval.mjs`
- Modify: `README` note or `docs/` pointer is NOT required; the script is self-documenting.

**Interfaces:**
- Consumes: a running local stack + `retrieve-context` endpoint + `SUPABASE_URL` / a user JWT via env. Opt-in, NOT wired into CI.
- Produces: prints end-to-end Recall@K for a hand-listed set of queries with known expected memory ids.

- [ ] **Step 1: Write the opt-in harness**

Create `scripts/benchmark-retrieval.mjs`:

```js
// Optional, opt-in end-to-end retrieval harness. NOT a CI gate.
// Usage:
//   SUPABASE_URL=http://localhost:54321 USER_JWT=<jwt> node scripts/benchmark-retrieval.mjs
// Edit CASES below to reference real seeded memory ids in your local stack.
const URL_BASE = process.env.SUPABASE_URL;
const JWT = process.env.USER_JWT;
if (!URL_BASE || !JWT) {
  console.error("Set SUPABASE_URL and USER_JWT env vars."); process.exit(1);
}

const CASES = [
  // { query: "what deadline is approaching?", relevant: ["<memory-uuid>"] },
];

function recallAtK(ranked, relevant, k) {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

let r5 = 0, r10 = 0;
for (const c of CASES) {
  const res = await fetch(`${URL_BASE}/functions/v1/retrieve-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify({ query: c.query }),
  });
  const data = await res.json();
  const ranked = (data.context || []).map((x) => x.id);
  const rel = new Set(c.relevant);
  r5 += recallAtK(ranked, rel, 5);
  r10 += recallAtK(ranked, rel, 10);
}
const n = CASES.length || 1;
console.log({ cases: CASES.length, recall5: r5 / n, recall10: r10 / n });
```

- [ ] **Step 2: Full deno-check + test sweep (the CI gates locally)**

Run:
```bash
deno check supabase/functions/retrieve-context/index.ts
deno check supabase/functions/llm-worker/index.ts
deno test --allow-read --allow-net supabase/functions/retrieve-context/ranking.test.ts supabase/functions/retrieve-context/temporal.test.ts
deno test --allow-read supabase/functions/retrieve-context/eval/metrics.test.ts supabase/functions/retrieve-context/eval/benchmark.test.ts
npm run build
```
Expected: all pass; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark-retrieval.mjs
git commit -m "chore(eval): optional opt-in end-to-end retrieval harness"
```

---

## Notes for the implementer

- Run all `deno` commands from the repo root.
- If `supabase db reset` complains about Vault/cron, run `scripts/setup-worker.sql` per CLAUDE.md — it does not affect this plan's tables.
- The benchmark thresholds in Task 6 are **starting baselines**; once green, ratchet them up in a follow-up rather than down.
- Weight tuning loop: edit constants in `ranker.ts` → re-run `benchmark.test.ts` → keep if metrics improve. No migration needed for tuning.
