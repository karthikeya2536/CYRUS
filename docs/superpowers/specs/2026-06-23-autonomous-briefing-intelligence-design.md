# Autonomous Briefing Intelligence — Design Document

**Status:** Architecture only (no implementation)
**Date:** 2026-06-23
**Scope:** Cyrus V2 briefing pipeline — risk/blocker/opportunity/trend detection, confidence scoring, explanation generation, integration with knowledge engine + graph + lifecycle

---

## 1. Problem

The current briefing (`generate-briefing` → `processBriefingGeneration` in
`llm-worker/index.ts:~501-619`) does one thing: gather recent emails + events + memories,
feed them to `LLMRouter`, and return a summary. When LLMs are unavailable,
`ruleBasedBriefing` substitutes a deterministic template.

This is a **summarizer**, not an **analyst**. It doesn't:

- identify risks before they materialize
- surface blockers in dependency chains
- detect opportunities (stalled threads, reciprocity gaps)
- track trends across time windows
- notice what's missing (absent expected replies, ownerless projects)
- score confidence or provide evidence trails
- distinguish signal from noise with per-user calibration

The four new design layers make analytical briefing possible:

- **Consolidation** (033): per-entity cluster profiles with temporal context
- **Knowledge Graph** (034): typed nodes/edges with transitive dependency chains
- **Lifecycle** (035): relevance scores, decay, archival — what's rising, what's stale
- **Knowledge Engine** (036): derived facts (blockers, contradictions, missing info),
  subject state machines, project health, confidence propagation

**The briefing intelligence pipeline CONSUMES these layers.** It does not re-derive
facts, re-traverse the graph, or re-score relevance — it reads the pre-computed
structures and synthesizes them into a ranked, explained, prioritized daily insight set.

### Design constraints

- `CLAUDE.md`: *avoid schema changes unless required; prefer logic.* Additive tables
  for insight storage + telemetry are justified. **Zero columns added to `memory_records`.**
- Migrations idempotent; CI `db reset` safe.
- Async work through `llm_jobs`/`llm-worker` with the reclaim→claim→retry→dead-letter
  invariants. New job type = free TEXT (no enum migration).
- `LLMRouter.execute()` circuit breaker; `rule-engine` sentinel → **every detection step
  must have a deterministic rule-based fallback** (mirrors `ruleBasedBriefing` pattern).
- pg_cron scheduling: Vault secrets guard (no-op if absent, stays `db reset` green).
- Embeds 768-dim; plans/quota metered (`consumeQuota`/`increment_usage`).

### Adjacent designs consumed

| Design | Provides |
|---|---|
| Consolidation (033) | Per-entity profiles → "relationship changes" and per-subject rollups for the briefing |
| Knowledge Graph (034) | Typed edges → blocker/dependency chains detected via traversal |
| Lifecycle (035) | Relevance scores, decay curves, archival state → trends (rising/falling relevance) |
| Knowledge Engine (036) | `derived_facts` (blockers, risks, missing_info, contradictions), `subject_state`, project health, dependencies → **the primary data source**: briefing intelligence mostly reads these |

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SOURCE LAYERS                                 │
│  memory_records (011)   entity_mentions (021)   memory_clusters (033)│
│  graph_nodes / graph_edges (034)   derived_facts / subject_state     │
│  / dependencies / contradictions (036)   lifecycle_state (035)      │
└────────────────────────────┬────────────────────────────────────────┘
                             │  (read by briefing pipeline)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│          BRIEFING INTELLIGENCE PIPELINE (new job_type)               │
│                                                                      │
│  ┌──────────────────────┐                                            │
│  │ STAGE 1: SIGNAL GATHER│   Query derived_facts (new/recent),       │
│  │ (deterministic)       │   subject_state changes, dependency       │
│  │                       │   chains, lifecycle trends, cluster       │
│  │                       │   activity, graph edge changes            │
│  └─────────┬────────────┘                                            │
│            ▼                                                         │
│  ┌──────────────────────┐                                            │
│  │ STAGE 2: DETECT      │   Classify signals into insight types:     │
│  │ (rule-based + LLM)   │   RISK / BLOCKER / OPPORTUNITY / TREND /   │
│  │                       │   MISSING_INFO / RELATIONSHIP_CHANGE       │
│  │  Each insight has:    │   type, subject, statement, evidence,      │
│  │                       │   raw_score, source data                   │
│  └─────────┬────────────┘                                            │
│            ▼                                                         │
│  ┌──────────────────────┐                                            │
│  │ STAGE 3: SCORE       │   Compute insight-level confidence +       │
│  │ (deterministic)       │   severity/impact + novelty + urgency      │
│  │                       │   → calibrated 0-1 composite              │
│  └─────────┬────────────┘                                            │
│            ▼                                                         │
│  ┌──────────────────────┐                                            │
│  │ STAGE 4: RANK/SELECT │   Rank by composite, enforce per-section   │
│  │ (deterministic)       │   budget (e.g. ≤3 risks, ≤2 blockers,     │
│  │                       │   ≤2 opportunities, ≤3 trends), suppress  │
│  │                       │   below confidence floor (0.3)            │
│  └─────────┬────────────┘                                            │
│            ▼                                                         │
│  ┌──────────────────────┐                                            │
│  │ STAGE 5: EXPLAIN     │   Generate human-readable "why" per insight│
│  │ (LLM + rule fallback) │   citing evidence memories/edges/facts    │
│  └─────────┬────────────┘                                            │
│            ▼                                                         │
│  ┌──────────────────────┐                                            │
│  │ STAGE 6: ASSEMBLE    │   Integrate with base summary, produce     │
│  │ (deterministic)       │   final briefing object; persist insights  │
│  │                       │   to briefing_insights table              │
│  └──────────────────────┘                                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         DELIVERY                                     │
│  briefing_insights table (persisted) → retrieved by briefing UI      │
│  + base summary (existing processBriefingGeneration, unchanged)      │
└─────────────────────────────────────────────────────────────────────┘
```

**Key design choice:** the briefing intelligence pipeline is a **separate job**
(not a rewrite of `processBriefingGeneration`). It runs as a new `job_type =
'briefing_intelligence'` enqueued by the `generate-briefing` function alongside
(or after) the existing `briefing_generation` job. The existing base summary job
is untouched — the intelligence pipeline **adds** structured insights to it.

**Feature flags:** `BRIEFING_INTELLIGENCE_ENABLED` controls the whole pipeline.
When off, `generate-briefing` enqueues only the legacy `briefing_generation` job.
When on, it also enqueues `briefing_intelligence`. The briefing UI merges the
results. This is the rollback lever (Tier 1, §12).

---

## 3. Data model

### 3.1 `briefing_insights` — the persisted insight

Each row is one analytical finding that made it into the briefing.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `briefing_id` | TEXT | groups insights from the same briefing run (date + run key) |
| `insight_type` | TEXT NOT NULL | `risk` \| `blocker` \| `opportunity` \| `trend` \| `missing_info` \| `relationship_change` |
| `subject` | TEXT NOT NULL | what this is about (entity name, project key, email subject, etc.) |
| `statement` | TEXT NOT NULL | one-sentence insight ("Project xConnect Onboarding is blocked because the Versant Outreach Email has not been sent") |
| `confidence` | DOUBLE PRECISION NOT NULL | 0-1, calibrated (§6) |
| `severity` | DOUBLE PRECISION | 0-1, how impactful (for risk/blocker types) |
| `urgency` | DOUBLE PRECISION | 0-1, time pressure (from deadline_at proximity) |
| `novelty` | DOUBLE PRECISION | 0-1, how new/surprising (1 = never surfaced before; decays on repeat) |
| `composite_score` | DOUBLE PRECISION NOT NULL | final ranking score = weighted sum of confidence+severity+urgency+novelty |
| `evidence_ids` | JSONB | `{ memories: [...], derived_facts: [...], edges: [...], clusters: [...] }` — trace to sources |
| `explanation` | TEXT | human-readable "why this matters" (LLM-generated, or rule-based template) |
| `explanation_by` | TEXT | provider that wrote the explanation (or `rule-engine`) |
| `windowing` | JSONB | `{ window_type: "daily"\|"weekly"\|"rolling_14d", compared_to: "prior_7d" }` — for trends |
| `actionable` | BOOLEAN DEFAULT FALSE | can the user DO something about this? (set by detection + explanation) |
| `dismissed` | BOOLEAN DEFAULT FALSE | user dismissed; future runs suppress similar (dedup by subject+insight_type, decay threshold) |
| `briefing_date` | DATE NOT NULL | which day's briefing this belongs to |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Indexes:** `(user_id, briefing_date)` — load any day's insights; `(user_id, insight_type, briefing_date)` —
trend queries ("show me all blockers this week"). UNIQUE `(user_id, briefing_id, insight_type, subject)`
prevents duplicate insights in the same briefing run.

### 3.2 `briefing_intelligence_runs` — telemetry

Mirrors `retrieval_runs` (`019_retrieval_observability.sql:13-24`). One row per
briefing intelligence pipeline invocation.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK NOT NULL | RLS |
| `briefing_date` | DATE NOT NULL | |
| `status` | TEXT | `completed` \| `partial` \| `failed` \| `skipped` (no signals) |
| `signals_gathered` | JSONB | `{ derived_facts: N, state_changes: N, lifecycle_trends: N, ... }` |
| `insights_detected` | JSONB | `{ risk: N, blocker: N, opportunity: N, trend: N, missing_info: N, relationship_change: N }` |
| `insights_published` | INTEGER | count that passed rank/select → briefing_insights |
| `llm_calls` | INTEGER | number of LLM invocations (detection + explanation) |
| `llm_failures` | INTEGER | calls that hit circuit breaker → rule fallback |
| `latency_ms` | INTEGER | total pipeline wall time |
| `model_used` | TEXT | provider that handled detection LLM calls |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

### 3.3 `briefing_feedback` — existing, reused

The existing `retrieval_feedback` table (`020_retrieval_feedback.sql`) can be
extended with `feedback_type = 'briefing_insight'` to track user signals on
specific insights (thumbs-up/down, dismiss, "show more like this"). Same RLS,
same pattern. No new table needed.

### 3.4 Data flow: what the pipeline reads (not writes)

The pipeline reads these tables (all existing or from adjacent designs) and
writes ONLY `briefing_insights` + `briefing_intelligence_runs`:
- `derived_facts` (036) — blockers, risks, missing_info, contradictions
- `subject_state` (036) — state transitions, project health changes
- `dependencies` (036) — blocking chains
- `memory_clusters` (033) — per-entity profiles for relationship changes
- `memory_records.lifecycle_state` (035) — relevance trends
- `graph_edges` (034) — recent edge insertions/deletions for relationship changes
- `retrieval_feedback` (020) — user reinforcement signals (briefing-level)

---

## 4. Pipeline design

### 4.1 Triggering

Two schedules, both via `pg_cron` + `pg_net` (matching the existing
`026_schedule_briefing_generation.sql` pattern):

| Schedule | Scope | Purpose |
|---|---|---|
| Daily (e.g. 06:57 local) | Full briefing intelligence run | Primary user-facing briefing |
| Every 4h (lightweight) | Trend window update only | Keeps trends fresh without full re-analysis |

The existing `generate-briefing` edge function gains a new code path (flag-gated):
after enqueuing the `briefing_generation` job (legacy summary), it also enqueues
a `briefing_intelligence` job with `{ user_id, briefing_date }` in the payload.

**Quota:** briefing intelligence consumes one `briefing` quota unit per daily run
(aligns with existing `consumeQuota` in the enqueue step). Lightweight trend runs
do not count against quota. Plan limits enforced per `_shared/plans.ts`.

### 4.2 Stage 1: Signal gathering

Deterministic. Queries all source layers in parallel (one query per layer, via
`supabaseAdmin` to bypass RLS). For a given `(user_id, briefing_date)`:

| Signal source | Query | What it captures |
|---|---|---|
| `derived_facts` | `WHERE created_at > briefing_date - INTERVAL '1 day' AND (fact_type IN (blocker,risk,missing_info) OR severity > 0.4)` | Newly derived risks/blockers/missing info; high-severity facts |
| `subject_state` | `WHERE updated_at > briefing_date - INTERVAL '1 day' AND state IN (blocked,at_risk,stalled)` | State transitions that signal problems |
| `dependencies` | `WHERE active = TRUE AND derived_from_fact IN (recent derived_fact IDs)` | Blocking chains for contextual amplification |
| `memory_clusters` | `WHERE last_consolidated_at > briefing_date - INTERVAL '2 days' AND member_count >= 3` | Recently updated entity profiles (relationship changes) |
| `memory_records` (via lifecycle 035) | `WHERE lifecycle_state = 'active' ORDER BY relevance_score DESC LIMIT 50` | Top trends: which subjects have rising/falling relevance |
| `graph_edges` (034) | `WHERE created_at > briefing_date - INTERVAL '1 day'` | New relationships formed ("Keerthana now assigned to xConnect") |
| `contradictions` (036) | `WHERE resolved_at IS NULL AND created_at > briefing_date - INTERVAL '3 days'` | Unresolved conflicts to surface |

**Fallback:** any query that fails or times out simply omits that signal category.
The pipeline proceeds with partial data (logged in `briefing_intelligence_runs.status
= 'partial'`).

### 4.3 Stage 2: Detection

Two passes — rules first (always), LLM second (enriches, never blocks).

#### Pass 1: Rule-based detectors (deterministic, 0 LLM calls)

Each detector consumes Stage 1 signals and produces candidate `briefing_insights`
(not yet persisted — candidates for Stage 3 scoring).

| Detector | Trigger | Insight type | Source table(s) |
|---|---|---|---|
| **BlockerDetector** | `derived_fact.fact_type='blocker'` with active subject_state='blocked' | `blocker` | derived_facts, subject_state, dependencies |
| **RiskDetector** | `derived_fact.fact_type='risk'`, OR deadline_at < 3d + no progress, OR project health < 0.4 | `risk` | derived_facts, subject_state, trackables |
| **MissingInfoDetector** | `derived_fact.fact_type='missing_info'`, OR project with no owner, OR commitment with no deadline | `missing_info` | derived_facts. missing_owner/missing_deadline are rule-detected in the engine (036 §4.3) |
| **OpportunityDetector** | Stalled subject (state='stalled' > 14d) but deadline not missed; reciprocity edge detected (Person A emailed, Person B hasn't replied in 10d + email was important) | `opportunity` | subject_state, graph_edges, memory_records (email source) |
| **TrendDetector** | Relevance score changed by >0.3 vs prior 7d window; email volume 2× baseline; cluster member_count growth > 3 | `trend` | lifecycle relevance (035), email count aggregation, memory_clusters |
| **RelationshipChangeDetector** | New graph edge created (works_on, assigned_to, signed); cluster profile changed (new member joined); entity mention frequency spike | `relationship_change` | graph_edges, memory_clusters, entity_mentions |

Each detector's output: `{ insight_type, subject, statement, evidence_ids, raw_score }`
where `raw_score` is a rule-computed 0-1 signal strength (not yet the final confidence).

**Example — BlockerDetector output:**
```json
{
  "insight_type": "blocker",
  "subject": "xConnect Onboarding",
  "statement": "xConnect Onboarding is blocked because Versant Outreach Email has not been sent",
  "evidence_ids": {
    "derived_facts": ["fact-001"],
    "edges": ["edge-042", "edge-043"],
    "memories": ["mem-101", "mem-102", "mem-103"]
  },
  "raw_score": 0.81
}
```

#### Pass 2: LLM enrichment (optional, skipped on rule-engine sentinel)

LLMRouter called with a prompt containing:
- All rule-detected candidates (structured JSON)
- Recent cluster summaries for context
- User's active projects/goals

LLM output: additional candidates the rules missed + refined `statement` text for
rule candidates + `actionable` boolean for each. Failure → skip, rules-only output
is fully sufficient. The `ruleBasedBriefing` equivalent is `ruleBasedInsightDetection`
— a pure template that wraps rule output.

### 4.4 Stage 3: Confidence scoring (deterministic)

Each candidate insight receives a calibrated composite score for ranking:

```
composite = W_SEV × severity + W_CONF × confidence + W_URG × urgency
          + W_NOV × novelty + W_ACT × actionable_bonus

  severity:    from derived_fact.severity, or rule-computed (0-1)
  confidence:  from derived_fact.confidence, or rule-computed (§6)
  urgency:     piecewise on min(deadline_at) for subject, same curve as
               ranker.ts urgency signal: >30d→0, 14-30→0.2, 7-14→0.4,
               3-7→0.7, ≤3→1.0 (ranker.ts lines ~80-100)
  novelty:     1.0 - exp(-times_surfaced_before / 3)
               (3rd time seeing same insight → novelty = 1 - e^(-2/3) = 0.49)
  actionable:  +0.10 if actionable=true (small bonus, doesn't dominate)

  W_SEV=0.35, W_CONF=0.25, W_URG=0.20, W_NOV=0.15, W_ACT=0.05
```

Weights are env-tunable. Defaults prioritize severity (blockers > noise) and
confidence (proof > speculation).

### 4.5 Stage 4: Rank and select (deterministic)

1. Sort all candidates by `composite` desc.
2. Filter `composite < CONFIDENCE_FLOOR` (default 0.30).
3. Enforce per-section budgets:

| Insight type | Max per briefing |
|---|---|
| `blocker` | 3 |
| `risk` | 3 |
| `missing_info` | 3 |
| `opportunity` | 2 |
| `trend` | 3 |
| `relationship_change` | 2 |
| **Total** | **≤12** |

4. Dedup by subject: if a subject appears in multiple types, keep the highest-score
   type only (e.g. a blocker + a risk about the same project → blocker wins if
   `composite` is >= the risk; otherwise the risk stays and the blocker is suppressed).

### 4.6 Stage 5: Explanation generation

Each selected insight gets an explanation — a 1-2 sentence "why this matters" that
cites specific evidence.

**LLM path:** prompt with insight + evidence summaries + subject context.
Output: explanation text.

**Rule-based fallback (template):**
```
"[statement]. Based on: [evidence summary]. [actionable ? 'Consider addressing this.' : '']"
```

Example: *"xConnect Onboarding is blocked because the Versant Outreach Email has not
been sent. Based on: missing expected reply to Versant (email sent 12 days ago, no
response). Consider following up with Versant."*

The explanation is stored in `briefing_insights.explanation` tagged with
`explanation_by = provider` or `'rule-engine'`.

### 4.7 Stage 6: Assembly

1. Upsert `briefing_insights` rows by `(user_id, briefing_id, insight_type, subject)`.
2. Write `briefing_intelligence_runs` row (telemetry).
3. Return structured insight set to the caller.

The briefing UI (React `Briefings.jsx`) merges the legacy base summary (from
`briefing_generation` job) with the structured insight JSON from `briefing_insights`
for the date. When the intelligence flag is off, only the base summary renders —
no schema change, no UI break.

### 4.8 Integration with existing processBriefingGeneration

The existing briefing flow (`llm-worker:501-619`) is **unchanged**. The new
`briefing_intelligence` job runs **alongside** it, not inside it. Both enqueued
by `generate-briefing/index.ts`. The worker gains one new dispatch branch:

```
if (job.job_type === 'briefing_intelligence') {
  result = await processBriefingIntelligence(job);
}
```

This preserves the existing reclaim → claim → retry → dead-letter invariants
(`llm-worker:632-758`) with zero changes to the worker loop itself.

---

## 5. Risk detection (requirement 1)

| Risk signal | Source | Rule | Confidence source |
|---|---|---|---|
| Deadline < 3 days, no progress in 7 days | `subject_state` + `trackables` | deadline_health < 0.3 AND activity_health < 0.5 | 0.70 |
| Project health < 0.4 | `subject_state.health` (036) | health below threshold | 0.75 (health is a computed aggregate) |
| Contradiction unresolved | `contradictions` (036) | `resolution IS NULL` | 0.85 (contradiction detection is certain) |
| Key person went dormant | lifecycle state (035) + graph edges: Person node with `works_on` edges to active projects, but lifecycle_state='dormant' | active projects depend on dormant person | `min(project_health, 1 - lifecycle_relevance)` |
| Dependency chain at risk | `dependencies` (036): A blocks B blocks C; B at risk | transitive risk propagation (C gets risk = B.risk × 0.7) | propagate confidence with 0.7^hops decay |

---

## 6. Blocker detection (requirement 2)

Blockers are the highest-priority insight type. Detection is primarily rule-based
(from the knowledge engine's `derived_facts` where `fact_type='blocker'`), with
graph traversal for amplification.

| Blocker signal | Source | Amplification |
|---|---|---|
| `derived_fact.fact_type='blocker'` | Knowledge Engine (036) `transitive_dependency_blocked` rule | Graph hop count: 1 hop → severity=1.0, 2 hops → 0.8, 3 hops → 0.6 |
| Project `subject_state='blocked'` | Knowledge Engine (036) state machine | Health score provides severity |
| Expected reply missing > 14 days | Knowledge Engine `expected_reply_missing` rule → derived_fact of type `missing_info` with severity≥0.7 | If 2+ other facts depend on this reply, severity *= 1.3 |

Amplification is the briefing's unique contribution: the knowledge engine derives the
atomic blocker fact; the briefing pipeline amplifies it by traversing the dependency
graph to find what ELSE is affected.

**Worked example:**
- Engine: "xConnect Onboarding blocked by Versant email" (severity 0.80, conf 0.81)
- Briefing graph query: what depends on xConnect Onboarding?
  → 1 hop: Keerthana's contract execution (status: pending, edge type: `depends_on`)
- Amplified blocker statement: "xConnect Onboarding is blocked by missing Versant
  email — this also blocks Keerthana Rao's contract execution (pending)."
- Severity: base 0.80 × amplification 1.2 (1 dependent found) = 0.96

---

## 7. Opportunity detection (requirement 3)

Opportunities are "things the user could act on that they might not have noticed."
Less critical than risks/blockers — included on a budget.

| Opportunity signal | Source | Detection rule |
|---|---|---|
| Stalled subject with approaching but unmissed deadline | `subject_state` (stalled) + `trackables.deadline_at` > now() + `trackables.deadline_at` < now() + 7d | "X is stalled but the deadline hasn't passed — opportunity to recover" |
| Reciprocity gap | `graph_edges`: Person A emailed, Person B hasn't replied; email classified as important (llm_importance > 0.6); age > 7 days | "Following up with Person B on X could move this forward" |
| Warm relationship turning cold | `memory_clusters`: entity had activity in months 1-2, then zero in month 3. Graph edges show prior collaboration. | "X was active but has gone quiet — re-engagement opportunity" |
| Rising-trend subject without an owner | lifecycle relevance increasing (035), but no `works_on` / `assigned_to` edge to any Person | "X is gaining attention but has no owner — opportunity to assign" |

---

## 8. Trend detection (requirement 4)

Trends compare two adjacent time windows. The pipeline computes:

| Trend type | Base window | Comparison window | Signal |
|---|---|---|---|
| Relevance trending up/down | Current 7d | Prior 7d | `Δ relevance_score > 0.3` (rising) or `< -0.3` (falling) |
| Email volume spike | Current 3d | Prior 7d avg/day | Current > 2× baseline |
| Project momentum | Current 7d activity_count | Prior 7d | Count of new memories + edges for the project |
| Entity mention frequency | Current 7d | Prior 7d | Entity appears in 2× more `entity_mentions` rows |
| Cluster growth | Current `member_count` | `member_count` from 7d ago (stored in `memory_clusters` or recomputed) | Δ > 3 new members |

**Windowing implementation:** deterministic queries over `created_at` ranges.
`briefing_insights.windowing` stores the window parameters for reproducibility.
Trend detection is purely rule-based (no LLM needed) — it's SQL aggregation +
threshold comparison.

---

## 9. Missing information detection (requirement 5)

"Missing information" means the *absence* of expected data. This is the hardest
detection problem because it requires knowing what SHOULD exist.

The Knowledge Engine (036) handles the detection. The briefing pipeline surfaces it.

| Missing info type | Knowledge engine rule (036 §4.3) | Briefing amplification |
|---|---|---|
| Missing deadline | `missing_deadline`: project/commitment tracked, no `deadline_at` | If project is `active` or `blocked`, amplify severity |
| Missing owner | `missing_owner`: project has no `works_on`/`assigned_to` edge to Person | If project health < 0.6, amplify |
| Expected reply missing | `expected_reply_missing`: email sent + 7d elapsed + no reply | If the email was about a blocker subject, severity *= 1.5 |
| Missing follow-up | commitment-type memory with `created_at` > 14d and no subsequent memory/event mentioning same entity | Confidence decays with age (older missing item = less actionable) |

The briefing pipeline reads `derived_facts WHERE fact_type = 'missing_info'` from
Stage 1, filters by `confidence > 0.5`, and presents them under a "⚠️ Needs
Attention" section.

---

## 10. Confidence scoring (requirement 6)

### 10.1 Per-insight confidence

Each insight's confidence is computed from source confidences:

```
For rule-detected insights:
  confidence = source_confidence × rule_confidence_multiplier

  source_confidence:
    - if the insight maps 1:1 from a derived_fact: derived_fact.confidence
    - if detected directly from raw signals (e.g. trend):
        avg(contributing_signal_confidences)

  rule_confidence_multiplier: fixed per detector (calibrated):
    BlockerDetector:      0.95 (blockers are well-defined)
    RiskDetector:         0.85
    MissingInfoDetector:  0.80 (absence is harder to verify)
    OpportunityDetector:  0.70 (opportunities are speculative)
    TrendDetector:        0.90 (math-based, high confidence)
    RelationshipChange:   0.85

For LLM-enriched insights:
  confidence = base (from rule) × 0.90 (LLM verification discount)
  Never exceeds 0.90 — LLM output is always discounted vs. deterministic detection.
```

### 10.2 Calibration

Confidence must mean "P(insight is actually useful to the user)." Calibrate via:

1. User feedback signal: `briefing_feedback.feedback_type='briefing_insight'` with
   rating (useful/not_useful). Track precision per detector type.
2. If a detector has < 60% useful rate over 20 samples, reduce its
   `rule_confidence_multiplier` by 0.05. If > 85%, increase by 0.05.
3. This is a deferred feature (Phase 5+), but the confidence model supports it.

---

## 11. Explanation generation (requirement 7)

Each published insight carries a human-readable explanation.

**LLM path:** prompt contains:
- The insight statement + type + subject
- Summarized evidence (memory content snippets, graph edge labels, derived fact summaries)
- Context (related insights, project state)
- Instruction: "Explain in 1-2 sentences why this matters to the user, citing specific evidence. Be concrete, not abstract."

**Rule-based fallback:** template per insight type:
```
blocker: "[statement]. Evidence: [N] dependencies are blocked by this. [N] source memories confirm."
risk: "[statement]. Deadline: [date]. Last activity: [date]."
opportunity: "[statement]. This has been stalled for [N] days; deadline is [N] days away."
trend: "[subject] [direction: gained|lost] relevance this week. [metric] changed from [old] to [new]."
missing_info: "[statement]. This has been missing for [N] days. [N] items depend on it."
relationship_change: "[subject] [change: joined|left|changed role in] [context]. Based on [N] new signals."
```

---

## 12. Retrieval integration (requirement 8)

The briefing pipeline uses the existing retrieval infrastructure for context
gathering, not re-deriving signals:

1. **Cluster context:** `hybrid_search_clusters` (033) to get rich entity profiles
   for subjects mentioned in insights — used to enrich explanations.
2. **Memory evidence:** `hybrid_search_memories` with the subject filter to fetch
   source memory snippets for evidence summarization (avoid re-querying individual
   memories by ID when the evidence list is long).
3. **Graph traversal:** `graph_expand_memories` (or the typed equivalent from 034)
   to trace dependency chains for blocker amplification.

The pipeline uses the **existing RPCs** — no new retrieval infrastructure needed.
It queries as service-role (supabaseAdmin) since it's an internal job (like the
briefing generator today, which calls LLMRouter not user-facing RPCs).

---

## 13. Knowledge graph integration (requirement 9)

The knowledge graph (034) is the structural backbone for:

| Briefing capability | Graph query |
|---|---|
| Blocker amplification | Traverse `blocked_by` edges out from blocked subject, find all downstream dependents |
| Relationship change detection | Query edges created in the window; group by subject; surface new `works_on`/`assigned_to`/`signed` edges |
| Risk propagation | Traverse `depends_on` chains; any blocked node in the chain → risk signal for everything upstream |
| Opportunity: orphan detection | Find Project/Task nodes with no incoming `works_on`/`assigned_to` edges → "unowned work" |
| Context enrichment | For any insight with a subject, fetch the 1-hop subgraph to include related entities in the explanation |

These are reads over the graph, not writes — the briefing pipeline has no graph
write path (invariant maintained from 034).

---

## 14. Lifecycle integration (requirement 10)

The memory lifecycle system (035) provides:

| Briefing capability | Lifecycle data |
|---|---|
| Trend: rising/falling relevance | `memory_records.relevance_score` trajectory over time windows |
| Trend: entity going dormant | `memory_clusters`: members' aggregate lifecycle_state trending toward `dormant`/`archived` |
| Suppression of stale insights | If an insight's source memories are all `archived`, suppress the insight (confidence floor = 0 → pruned at Stage 4) |
| Reactivation signal | A memory transitioning from `archived` → `active` (resurrection, 035) → insight type `relationship_change` with increased novelty |

---

## 15. Failure handling

| Failure mode | Response |
|---|---|
| LLM down (rule-engine sentinel) | All detection runs rule-based; explanations use templates. Pipeline completes successfully with `llm_failures = N` in telemetry. |
| Knowledge engine not yet run for this user | `derived_facts` empty → BlockerDetector, RiskDetector, MissingInfoDetector produce zero rule candidates. LLM pass may detect some from raw signals. `status = 'partial'`. |
| Graph not yet constructed | Edge-based detectors (RelationshipChange, blocker amplification) get empty results. `status = 'partial'`. |
| Partial signal sources (some queries timed out) | Proceed with available signals. Log which sources failed in `briefing_intelligence_runs.signals_gathered` with error markers. |
| Zero insights detected | `status = 'skipped'`, no `briefing_insights` rows written. Briefing UI shows base summary only. |
| Pipeline timeout (>55s, cron limit) | Worker processes up to 5 jobs/run. Pipeline chunks by insight type if needed. A watchdog exits gracefully after 50s, committing partial results. |
| Quota exceeded | `consumeQuota` fails → pipeline aborted before any LLM calls. `status = 'failed'`, reason = 'quota_exceeded'. Same as existing pattern. |

### Telemetry

`briefing_intelligence_runs` captures every outcome. Additional `briefing_intelligence_errors`
table (mirror `retrieval_failures` from `019_retrieval_observability.sql:38-56`):
`(run_id, user_id, stage, detector, message, created_at)`. Best-effort, non-blocking.

---

## 16. Rollback strategy

Three tiers (same pattern as all adjacent designs):

### Tier 1 — Feature flag (instant)

`BRIEFING_INTELLIGENCE_ENABLED` env var. `false` → `generate-briefing` skips enqueuing
the `briefing_intelligence` job entirely. Only the legacy `briefing_generation` job runs.
Briefing UI shows only the base summary. No data change, no schema impact.

### Tier 2 — Drop the layer

Drop `briefing_insights` and `briefing_intelligence_runs` tables (down-migration).
The legacy `briefing_generation` path is unchanged. The briefing UI falls back to
base-summary-only mode. **No source data affected** — the pipeline only writes its
own tables.

### Tier 3 — Per-insight suppression

`briefing_insights.dismissed = true` for a specific subject+type. Future runs suppress
similar insights (cosine similarity on statement > 0.7 with previously dismissed).
Per-user, per-subject rollback without touching the pipeline.

---

## 17. Migration plan

**Migration 037** — `037_briefing_intelligence.sql`:

- `CREATE TABLE IF NOT EXISTS briefing_insights` (columns per §3.1) +
  `briefing_intelligence_runs` (§3.2) + `briefing_intelligence_errors` (§15).
- RLS: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; `CREATE POLICY ... FOR SELECT
  USING (auth.uid() = user_id)`; service-role writes.
- Indexes per §3.1 (`IF NOT EXISTS`).
- Idempotent policy drops (`DROP POLICY IF EXISTS`).
- No new RPCs required (the pipeline is an internal worker job, not user-facing).
- No ALTERs to `memory_records`, `llm_jobs`, or any existing table.
- `job_type` = `'briefing_intelligence'` added as free TEXT (no constraint migration
  needed — `llm_jobs.job_type` is TEXT per `011_reconstruct_schema.sql:73-99`).

**Vault secrets:** `BRIEFING_INTELLIGENCE_ENABLED` (default `false` — gated rollout).
Optional tuning flags exposed as env vars (weights, budgets, thresholds).

**pg_cron schedule:** separate cron job `briefing-intelligence-daily` (`minute=57,
hour=6`) mirroring the existing `generate-briefing` schedule pattern
(`026_schedule_briefing_generation.sql`). Schedule only if Vault secrets
`project_url` + `worker_secret` exist (else no-op, `db reset` safe).

---

## 18. Testing strategy

### 18.1 Deterministic pipeline tests (Deno)

| Test | What it validates |
|---|---|
| `detector_blocker_rule()` | Given `derived_fact` (blocker, conf=0.81, severity=0.80) + `subject_state=blocked` → BlockerDetector produces candidate with correct evidence |
| `detector_risk_rule()` | Given trackable with deadline_at < 3d + no activity 7d → RiskDetector produces risk candidate |
| `detector_missing_info_rule()` | Given `derived_fact` of type `missing_info` → MissingInfoDetector surfaces it |
| `detector_trend_rule()` | Given relevance_score trajectory [0.2, 0.3, 0.5, 0.8] over 7d comparison → TrendDetector detects `rising` with Δ=0.6 |
| `detector_opportunity_rule()` | Given stalled subject (state='stalled' for 15d) + deadline in 5d → OpportunityDetector surfaces "opportunity to recover" |
| `confidence_scoring()` | Verify composite formula produces correct values for known inputs |
| `rank_and_select_budget()` | 5 blockers, 2 risks, 1 trend → blockers capped at 3, all others included; total ≤ 12 |
| `dedup_by_subject()` | Two insights (blocker + risk) about same subject → only higher-score survives |
| `novelty_decay()` | Same insight surfaced 3 times before → novelty = 1 - e^(-2/3) = 0.49 |
| `llm_fallback()` | LLMRouter returns rule-engine → all detectors run rule-only, explanations use templates, pipeline completes with `llm_failures = detection_count` |
| `partial_sources()` | `derived_facts` query fails → pipeline proceeds without blocker/risk/missing_info candidates; `status='partial'` logged |
| `rollback_flag()` | `BRIEFING_INTELLIGENCE_ENABLED = 'false'` → no job enqueued; legacy path unchanged |
| `idempotent_insight_upsert()` | Run pipeline twice for same date → no duplicate `briefing_insights` rows; second run updates explanations |

### 18.2 End-to-end fixture: Versant onboarding blocker in briefing

```
Setup (same fixture as knowledge engine 036 §14.2):
  - memories m1, m2, m3 (Contract signed, Follow-up pending, Versant email missing)
  - graph edges: onboarding blocked_by versant-followup, versant-followup requires versant-email
  - derived_fact: "onboarding blocked by missing Versant email" (blocker, conf=0.81, sev=0.80)
  - subject_state: onboarding = 'blocked', health=0.48
  - lifecycle: all source memories active, relevance 0.6-0.9

Run: briefing_intelligence pipeline for briefing_date=2026-06-23

Assert:
  - briefing_insights has row with:
      insight_type = 'blocker'
      subject = 'xConnect Onboarding'
      confidence > 0.75
      severity > 0.75
      composite_score > 0.60
      evidence_ids.derived_facts contains the engine fact
      explanation is non-empty string (rule template or LLM)
  - briefing_intelligence_runs row with status='completed', insights_detected.blocker >= 1
  - briefing_intelligence_errors is empty
  - memory_records unchanged
  - derived_facts unchanged
  - graph_edges unchanged
```

### 18.3 Confidence calibration test

```
For each detector type:
  1. Run 50 scenarios with known ground-truth usefulness.
  2. Measure: is confidence correlated with actual usefulness?
  3. Assert: blocker detector precision > 0.75; opportunity detector precision > 0.55.
  4. If a detector's precision is below threshold, it's a calibration failure, not a logic bug.
```

### 18.4 CI integration

- `deno test supabase/functions/briefing-intelligence/*.test.ts` (if edge function tests)
  or `deno test tests/briefing-intelligence/*.test.ts`.
- RPC verification: `deno test` with local Postgres + `supabase.rpc()` calls.
- Flag toggle: set `BRIEFING_INTELLIGENCE_ENABLED=false` → assert no `briefing_intelligence`
  jobs created, legacy path runs identically.

---

## 19. Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Pipeline placement | **Separate `briefing_intelligence` job** | Extend `processBriefingGeneration` inline | Legacy path untouched; rollback is one flag; each can fail independently. Cost: two jobs to enqueue, minor scheduling complexity. |
| Detection floor | **Rules always; LLM enriches** | LLM-only detection | LLM-down → blank briefing is unacceptable. Rules provide a guaranteed floor. Matches all existing patterns (ruleBasedBriefing, ruleBasedExtraction). |
| Insight storage | **Persisted `briefing_insights` table** | Computed on-the-fly in briefing UI | Enables historical trend queries, user feedback collection, confidence calibration, and novelty tracking across runs. Cost: one more table. |
| Explanation strategy | **LLM with deterministic templates** | Always-LLM or always-template | Rich when possible, functional when not. Templates are specific per insight type (not one generic fallback). |
| Confidence model | **Rule-multiplier per detector** | Bayesian network | Simple, calibrated per detector, feedable by user feedback. Sufficient for v1. Cost: multipliers need initial calibration. |
| Trend windowing | **Fixed 7d comparison** | Adaptive windows per subject | Simple, comparable across subjects, mathematically transparent. Cost: misses very-long-period trends (monthly). |
| Per-section budgets | **Fixed caps per type** | Unified ranking with no caps | Ensures briefing diversity (not all blockers all the time); user sees opportunities and trends even when blockers exist. |
| Quota model | **One briefing unit per daily run** | Per-insight metering | Aligns with existing quota model; no new metering infrastructure. Trend-only sub-runs are free. |

---

## 20. Worked example: full briefing entry

### Briefing for 2026-06-23 — xConnect Onboarding

```
═══════════════════════════════════════════════
  🚨 BLOCKER
═══════════════════════════════════════════════

xConnect Onboarding is blocked because the
Versant Outreach Email has not been sent.

Confidence: 0.81  |  Severity: 0.96  |  Actionable: Yes

Why: The Versant email was expected 12 days ago
and has not been received. This blocks the
onboarding process, which also blocks
Keerthana Rao's contract execution (pending).
Based on: email record from June 11 (no reply),
project dependency chain (2 affected items).
Consider following up with Versant today.

Evidence: 3 memories • 2 graph edges • 1 derived fact

───────────────────────────────────────────────

═══════════════════════════════════════════════
  ⚠️ MISSING INFORMATION
═══════════════════════════════════════════════

xConnect Onboarding has no deadline set.

Confidence: 0.85  |  Severity: 0.45  |  Actionable: Yes

Why: The project is actively blocked but has no
target completion date, making it hard to
prioritize. Based on: project tracker shows
no deadline in any associated commitment or
milestone memory. Consider setting a deadline.

Evidence: project state • 0 deadline associations

───────────────────────────────────────────────

═══════════════════════════════════════════════
  📈 TREND
═══════════════════════════════════════════════

Keerthana Rao is gaining relevance this week.

Confidence: 0.90  |  Novelty: 0.86  |  Actionable: No

Why: Activity related to Keerthana increased
2.3× vs last week (4 new memories, 2 new graph
edges). Her cluster now has 6 active members
(was 4). Most activity is related to xConnect
Onboarding and contract execution.

Evidence: 6 memory records • 2 graph edges • cluster profile

═══════════════════════════════════════════════
```

Each insight traces back to specific, queryable source data. The base summary
(unchanged `processBriefingGeneration` output) sits above or below this section,
providing the atmospheric daily recap. Together: **atmosphere + analysis**.

---

**File written:** `D:\cyrus v2\docs\superpowers\specs\2026-06-23-autonomous-briefing-intelligence-design.md`
