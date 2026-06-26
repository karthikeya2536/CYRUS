# Cyrus V2 Observability Platform — Design Document

**Status:** Architecture only (no implementation)
**Date:** 2026-06-23
**Scope:** Unified telemetry, tracing, metrics, dashboards, and alerting across all Cyrus V2 subsystems

---

## 1. Problem

The Cyrus V2 codebase has substantial observability **data** spread across 10+
telemetry tables, a structured JSON logger used by all 15 edge functions, and a
comprehensive system-validation test suite. But it has **no observability platform** —
no way to view, correlate, alert on, or act on that data.

Current state (verified from the codebase):

- `retrieval_runs`, `retrieval_rank_events`, `retrieval_failures` (`019_retrieval_observability.sql`)
  record per-query metrics but are queried only ad-hoc.
- `memory_extraction_logs` (`014_log_tables.sql`) records every extraction decision but
  is only read by system-validation's cost projection.
- `memory_merge_audit` (`018_memory_dedup.sql`) tracks dedup merges.
- `provider_health` (`011_reconstruct_schema.sql:104-118`) powers the circuit breaker
  but its time-series is lost — only current state is queried.
- `llm_jobs` (`011:73-99`) is the async queue observability surface but has no
  dashboard, no staleness alert, no throughput metrics.
- `briefings` (`011:123-142`) stores generation metadata + latency but has no
  aggregation view.
- `connected_accounts.last_sync_error` (`029`) captures sync failures but has no
  alerting — a broken Gmail connection is silent until the user checks.
- `rate_limits` (`013`) tracks per-function rate limiting but has no abuse detection.
- `usage_counters` (`017`) meters quota but has no cost projection or anomaly detection.
- `_shared/log.ts` emits structured JSON to stdout but has no transport, aggregation,
  or retention beyond Supabase's built-in Edge Function log viewer.
- `system-validation/index.ts` is the closest thing to a monitoring check — but it
  runs on-demand, not on a schedule.

**There is no external monitoring tool configured** (no Grafana, Prometheus, Datadog,
Sentry, or any other).

### Design constraints

- `CLAUDE.md`: *avoid schema changes unless required; prefer logic.* This design
  requires additive telemetry tables and a few new columns on existing tables (for
  cost tracing). All justified — observability is a cross-cutting concern.
- Migrations idempotent; CI `db reset` safe.
- No external dependencies — the codebase has none, and introducing e.g. a Grafana
  deployment is out of scope. Everything must run on the existing Supabase stack:
  Postgres + Deno edge functions + pg_cron.
- The existing structured logger (`_shared/log.ts`) and telemetry write patterns
  (`retrieve-context/index.ts:225-255`, `llm-worker/index.ts:312-318,402-411`) are
  the foundation — augment, don't replace.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     INSTRUMENTATION LAYER                            │
│                                                                      │
│  _shared/log.ts (enhanced)  ───►  structured JSON to stdout          │
│  _shared/trace.ts (NEW)     ───►  span/trace context propagation     │
│  _shared/metrics.ts (NEW)   ───►  in-memory counter pre-aggregation  │
│                                                                      │
│  Every edge function emits:                                          │
│    - log entries (unchanged pattern)                                 │
│    - trace spans (parent→child via trace_id/span_id headers)         │
│    - metric increments (counters, histograms, gauges)                │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     STORAGE LAYER (Postgres)                         │
│                                                                      │
│  NEW:                                                                 │
│  ├─ traces          (span trees with trace_id, parent_span_id)       │
│  ├─ metrics_snapshot (pre-aggregated 1min/5min/1h windows)          │
│  ├─ cost_events     (per-LLM-call token counts + estimated cost)     │
│  ├─ alerts          (alert definitions + firing state)              │
│  ├─ alert_history   (alert transitions: firing→resolved)            │
│  └─ dashboard_cache (materialized query results, 5min refresh)       │
│                                                                      │
│  ENHANCED:                                                            │
│  ├─ provider_health (+ token_count, cost_estimate, last_error)      │
│  ├─ llm_jobs        (+ trace_id, cost_estimate)                     │
│  ├─ briefings       (+ trace_id, token_count, cost_estimate)         │
│  ├─ retrieval_runs  (+ trace_id)                                    │
│  └─ connected_accounts (+ consecutive_failures, last_alerted_at)    │
│                                                                      │
│  EXISTING (unchanged, consumed by metrics views):                    │
│  ├─ retrieval_rank_events, retrieval_failures                       │
│  ├─ memory_extraction_logs, memory_merge_audit                      │
│  ├─ rate_limits, usage_counters                                     │
│  └─ retrieval_logs, retrieval_evaluations                           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PROCESSING LAYER (pg_cron + edge functions)      │
│                                                                      │
│  Every 1 min:  flush in-memory metric counters → metrics_snapshot    │
│  Every 5 min:  refresh dashboard_cache matviews                     │
│  Every 5 min:  evaluate alerts against metric thresholds            │
│  Every 1 hour: purge old trace data (retention: 7 days)             │
│  Every 1 day:  aggregate cost_events → cost_daily rollup            │
│  On-demand:     system-validation (existing, unchanged)             │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PRESENTATION LAYER                               │
│                                                                      │
│  Supabase Dashboard (existing): Edge Function logs + Postgres logs   │
│  Cyrus Admin UI (new React pages): dashboards querying matviews      │
│  Alerting (new): pg_cron→edge function→Slack/email webhook          │
│  Supabase Security/Performance Advisors (existing, unused → enable) │
└─────────────────────────────────────────────────────────────────────┘
```

**Key design principles:**

1. **Store in Postgres, query with SQL.** No external TSDB, no Grafana. The existing
   `retrieval_daily_stats` materialized view pattern (`019_retrieval_observability.sql:70-90`)
   is the model — extend it to all subsystems.

2. **Telemetry writes are fire-and-forget.** Mirror the existing `retrieve-context`
   pattern (`index.ts:224-255`): telemetry writes wrapped in try/catch, never block
   the response, failures logged as warnings.

3. **Pre-aggregate for dashboard queries.** Raw telemetry rows accumulate fast;
   materialized views refreshed on a schedule make dashboard queries constant-time.

4. **Backward-compatible.** Existing tables gain only nullable columns with defaults.
   Existing log calls are unchanged. New instrumentation is additive.

---

## 3. Database schema

### 3.1 New tables

#### 3.1.1 `traces` — distributed trace spans

Models a span tree across async boundaries. The existing `request_id` pattern
(`_shared/log.ts:8`) is the seed — every function already creates a `request_id`.
We extend it to propagate across `llm_jobs` chains.

| Column | Type | Purpose |
|---|---|---|
| `span_id` | UUID PK | This span's unique ID |
| `trace_id` | UUID NOT NULL | Root trace ID (propagated across all spans in a causal chain) |
| `parent_span_id` | UUID | NULL for root spans |
| `service` | TEXT NOT NULL | Function name (`retrieve-context`, `llm-worker`, `gmail-sync`, …) |
| `operation` | TEXT NOT NULL | `hybrid_search` \| `embedding_generation` \| `llm_call` \| `memory_upsert` \| `graph_expand` \| `ranking` \| `assembly` \| `sync` \| `token_refresh` \| … |
| `span_kind` | TEXT | `client` \| `server` \| `producer` \| `consumer` — OpenTelemetry-compatible |
| `started_at` | TIMESTAMPTZ NOT NULL | |
| `duration_ms` | INTEGER | Computed at span close |
| `status` | TEXT | `ok` \| `error` \| `unset` |
| `status_message` | TEXT | Error message if status=error |
| `attributes` | JSONB | Free-form key-value pairs (`{ "candidates_count": 30, "embedding_dim": 768 }`) |
| `user_id` | UUID | NULL for system spans |
| `job_id` | UUID | FK → `llm_jobs.id` if this span is a job execution |

**Indexes:** `(trace_id, started_at)` — reconstruct a full trace; `(service, operation, started_at)` —
latency analysis per operation; `(user_id, started_at)` — per-user traces.
**Partition key (optional, Phase 2+):** `started_at` (range partition by day).
**Retention:** 7 days via `pg_cron` purge (mirror `purge_retrieval_telemetry` at
`019_retrieval_observability.sql:97-124`).

#### 3.1.2 `metrics_snapshot` — pre-aggregated time-series metrics

Universal metrics table for all subsystems. One row per metric per time window.

| Column | Type | Purpose |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `metric_name` | TEXT NOT NULL | e.g. `retrieval_latency_p95`, `llm_call_count`, `job_queue_depth`, `sync_error_count` |
| `labels` | JSONB | `{ "service": "retrieve-context", "provider": "gemini-3.1-flash-lite", "status": "error" }` — dimensions |
| `window_start` | TIMESTAMPTZ NOT NULL | Start of the aggregation window |
| `window_seconds` | INTEGER NOT NULL | 60, 300, or 3600 (1min, 5min, 1hr) |
| `value` | DOUBLE PRECISION NOT NULL | Aggregated value |
| `count` | INTEGER | Number of observations in this window (for averages) |
| `min_val` | DOUBLE PRECISION | Minimum in window |
| `max_val` | DOUBLE PRECISION | Maximum in window |
| `p50` | DOUBLE PRECISION | |
| `p95` | DOUBLE PRECISION | |
| `p99` | DOUBLE PRECISION | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Indexes:** `(metric_name, window_start, window_seconds)`; `(window_start)` for purging.

**Canonical metric names:**

| Metric | Source | Aggregation |
|---|---|---|
| `retrieval_latency_ms` | `retrieval_runs.latency_ms` | avg, p50, p95, p99 |
| `retrieval_throughput` | `retrieval_runs` count | rate per minute |
| `retrieval_candidates_total` | `retrieval_runs.candidates_*` | avg |
| `retrieval_included_total` | `retrieval_runs.included` | avg |
| `retrieval_error_rate` | `retrieval_failures` count / `retrieval_runs` count | ratio per window |
| `extraction_count` | `memory_extraction_logs` (by decision) | count per window |
| `extraction_confidence_avg` | `memory_extraction_logs.confidence` | avg |
| `dedup_merge_count` | `memory_merge_audit` (by decision) | count per window |
| `job_queue_depth` | `llm_jobs` WHERE status='pending' | gauge (snapshot) |
| `job_processing_rate` | `llm_jobs` WHERE status='completed' | count per minute |
| `job_failure_rate` | `llm_jobs` WHERE status='permanently_failed' | count per minute |
| `job_staleness_max_seconds` | `llm_jobs` WHERE status='processing' | max(now() - started_at) |
| `llm_call_count` | `cost_events` (by provider, model) | count per window |
| `llm_call_latency_ms` | `cost_events.latency_ms` (by provider) | avg, p95, p99 |
| `llm_cost_estimate` | `cost_events.cost_estimate` | sum per window, per provider |
| `sync_success_count` | `connected_accounts` (by provider type) | count per window |
| `sync_error_count` | `connected_accounts.last_sync_error_at` (by provider type) | count per window |
| `provider_health_score` | `provider_health` (failure_count, success_count) | ratio per window |
| `rate_limit_hit_count` | `rate_limits` (by function) | count per window |
| `quota_exhaustion_count` | `usage_counters` (by metric) | count per window (when limit reached) |
| `briefing_latency_ms` | `briefings.generation_metadata->latency` | avg, p95 |
| `briefing_generation_count` | `briefings` count | count per window |

#### 3.1.3 `cost_events` — per-LLM-call cost tracking

The biggest single gap in the current system. Every LLM call (extraction, verification,
dedup, briefing generation, embedding) writes one row here.

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `trace_id` | UUID | Link to trace span |
| `span_id` | UUID | Link to the specific LLM call span |
| `user_id` | UUID | For per-user cost attribution |
| `job_id` | UUID | FK → `llm_jobs.id` |
| `provider` | TEXT NOT NULL | e.g. `gemini-3.1-flash-lite` |
| `model` | TEXT | Specific model version string from the API response |
| `operation` | TEXT NOT NULL | `extraction` \| `verification` \| `tiebreaker` \| `dedup_adjudication` \| `briefing_generation` \| `embedding` \| `consolidation_summary` \| `graph_relation_extraction` \| `inference` \| `insight_explanation` |
| `input_tokens` | INTEGER | From API response `usage.prompt_tokens` |
| `output_tokens` | INTEGER | From API response `usage.completion_tokens` |
| `total_tokens` | INTEGER | input + output |
| `cost_estimate` | DOUBLE PRECISION | Computed from token count × provider pricing; approximate |
| `latency_ms` | INTEGER | LLM call wall time |
| `status` | TEXT | `success` \| `error` \| `timeout` \| `rate_limited` |
| `error_message` | TEXT | NULL on success |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Indexes:** `(user_id, created_at)` — per-user cost over time; `(provider, created_at)` —
provider cost trends; `(operation, created_at)` — cost by operation type.
**Retention:** 90 days (cost data is small and valuable for trending).

#### 3.1.4 `alerts` — alert definitions

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `alert_name` | TEXT UNIQUE NOT NULL | e.g. `sync_failure_gmail`, `job_queue_stalled`, `high_error_rate_retrieval` |
| `description` | TEXT | Human-readable description |
| `metric_query` | TEXT NOT NULL | SQL query that returns a single numeric value (or a set of label:value pairs) |
| `condition` | TEXT NOT NULL | e.g. `value > 3`, `value == 0`, `value > 50` |
| `evaluation_window` | TEXT | e.g. `5 minutes`, `1 hour` |
| `severity` | TEXT | `critical` \| `warning` \| `info` |
| `channels` | TEXT[] | `{ 'log', 'slack_webhook', 'email' }` — v1: only 'log' is implemented; webhook/email are stubs |
| `cooldown_minutes` | INTEGER DEFAULT 15 | Minimum time between re-firing the same alert |
| `enabled` | BOOLEAN DEFAULT TRUE | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

#### 3.1.5 `alert_history` — alert firing log

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `alert_name` | TEXT NOT NULL | FK → `alerts.alert_name` |
| `state` | TEXT NOT NULL | `firing` \| `resolved` |
| `current_value` | DOUBLE PRECISION | Value that triggered/resolved the alert |
| `threshold` | DOUBLE PRECISION | Threshold at the time |
| `labels` | JSONB | Which specific label combination fired (for multi-dimensional alerts) |
| `fired_at` | TIMESTAMPTZ | |
| `resolved_at` | TIMESTAMPTZ | NULL if still firing |
| `notified` | BOOLEAN DEFAULT FALSE | Was a notification sent? |

#### 3.1.6 `dashboard_cache` — pre-computed dashboard tiles

Materialized views refreshed every 5 minutes. One row per dashboard tile.

| Column | Type | Purpose |
|---|---|---|
| `tile_key` | TEXT UNIQUE NOT NULL | e.g. `retrieval_latency_timeseries_24h`, `job_queue_health_snapshot`, `provider_cost_breakdown_7d` |
| `title` | TEXT | Display title |
| `section` | TEXT | `retrieval` \| `extraction` \| `jobs` \| `sync` \| `providers` \| `costs` \| `system` |
| `viz_type` | TEXT | `timeseries` \| `big_number` \| `table` \| `heatmap` \| `top_n` |
| `data` | JSONB | Pre-rendered chart data (labels + datasets) |
| `refreshed_at` | TIMESTAMPTZ | Last computation time |

### 3.2 Enhanced columns on existing tables

All nullable with defaults — zero impact on existing code paths.

#### `provider_health` (011_reconstruct_schema.sql:104-118)
```
ADD COLUMN total_tokens     BIGINT DEFAULT 0;       -- cumulative tokens through this provider
ADD COLUMN total_cost       DOUBLE PRECISION DEFAULT 0;  -- cumulative estimated cost
ADD COLUMN avg_latency_ms   DOUBLE PRECISION;        -- rolling average
ADD COLUMN last_error       TEXT;                    -- most recent error message
ADD COLUMN last_status_code INTEGER;                 -- most recent HTTP status
```

#### `llm_jobs` (011:73-99)
```
ADD COLUMN trace_id     UUID;               -- propagated trace context
ADD COLUMN cost_estimate DOUBLE PRECISION;   -- sum of LLM call costs for this job
ADD COLUMN token_count   INTEGER;           -- total tokens consumed by this job
```

#### `briefings` (011:123-142)
```
ADD COLUMN trace_id     UUID;
ADD COLUMN token_count   INTEGER;
ADD COLUMN cost_estimate DOUBLE PRECISION;
```

#### `retrieval_runs` (019:13-27)
```
ADD COLUMN trace_id UUID;  -- links to trace tree
```

#### `connected_accounts` (base schema 007 + 029)
```
ADD COLUMN consecutive_failures INTEGER DEFAULT 0;  -- incremented on failure, reset on success
ADD COLUMN last_alerted_at    TIMESTAMPTZ;          -- last time an alert fired for this account
```

#### `memory_records` (011:30-56)
```
ADD COLUMN extraction_job_id UUID;    -- trace back to which llm_jobs entry created this
ADD COLUMN extraction_trace_id UUID;  -- trace back to the extraction trace
```

---

## 4. Instrumentation library design

### 4.1 Enhanced logger (`_shared/log.ts`)

Additions to the existing 41-line logger:

- **Automatic timestamp:** add `"@timestamp": new Date().toISOString()` to every entry.
- **Stack trace capture:** `log.error(msg, err)` accepts an `Error` object as second
  argument and emits `{ stack: err.stack, message: err.message }`.
- **Level filtering by env:** `LOG_LEVEL` env var (default `info`, suppress `debug`
  in production).
- **Trace context injection:** if a `trace_id` is present in the current context,
  auto-include it in every log entry. No caller changes needed — the logger reads
  from an `AsyncLocalStorage`-like store (see §4.2).

Backward compatibility: the existing `createLogger(fn, requestId)` signature is
unchanged. All 15 existing call sites continue to work with zero modifications.

### 4.2 Trace context propagation (`_shared/trace.ts` — NEW)

```
Exports:
  - TraceContext { trace_id, span_id, parent_span_id }
  - startSpan(service, operation, opts?): Span
  - getCurrentTrace(): TraceContext | null
  - withTraceContext(ctx, fn): Promise<T>   // wrap async work with context propagation

Span API:
  - span.setAttribute(key, value)
  - span.setStatus(status, message?)
  - span.end()                            // computes duration_ms, writes to traces table
  - span.addEvent(name, attributes?)
```

**Propagation across job boundaries:**
When `memory-extraction` enqueues an `llm_jobs` row, it includes `trace_id` in the
payload. When `llm-worker` claims and processes that job, it reads `trace_id` from
the payload and creates a child span with `parent_span_id` linking back. This chains
the causal path: `gmail-sync` → `memory-extraction` (producer) → `llm-worker`
(consumer) → `memory_records` (output).

**Propagation across HTTP calls (pg_net / cron → edge function):**
The caller includes `traceparent` header (W3C Trace Context format). The callee
reads it and creates a child span. If absent, a new root trace is created.

**Storage:** span data is buffered in-memory during execution and flushed to the
`traces` table in a single batch INSERT at response time via `EdgeRuntime.waitUntil`
(pattern from `retrieve-context/index.ts:202-208`).

### 4.3 Metrics pre-aggregation (`_shared/metrics.ts` — NEW)

Lightweight in-memory counter/histogram API that avoids per-event DB writes:

```
Exports:
  - incrementCounter(metricName, value=1, labels={})
  - recordHistogram(metricName, value, labels={})
  - setGauge(metricName, value, labels={})

Implementation:
  - Stores counts in a module-level Map keyed by (metricName + JSON.stringify(labels))
  - Every REQUEST_FLUSH_INTERVAL (default: never during request — flushes happen
    at response time via a shared flush timer)
  - A pg_cron job every 1 minute calls the `flush_metrics_snapshot` RPC
    that reads from a shared in-memory store (NOT feasible in Deno's isolate model)
```

**Deno isolate constraint:** Deno edge functions run in isolated V8 isolates with
no shared memory between invocations. So metric pre-aggregation can only happen
**within a single request's lifetime**, not across requests. Therefore:

- **Within a request:** the `metrics.ts` module buffers counters/histograms and
  flushes to `metrics_snapshot` at response time (fire-and-forget).
- **Across requests:** the pg_cron metric aggregator (a new edge function
  `metrics-aggregator`) runs every 1 minute, queries raw telemetry tables
  (`retrieval_runs`, `llm_jobs`, `cost_events`, etc.), and INSERTs into
  `metrics_snapshot`. This is the primary aggregation path.

The in-request `metrics.ts` API is a convenience — it simplifies caller code
("just call `recordHistogram(...)`") and batches writes. The cross-request
aggregation is pure SQL, scheduled by pg_cron.

---

## 5. Traces: end-to-end distributed tracing

### 5.1 Trace anatomy

A trace is a tree of spans. The root span is created at the edge function entry
point. Child spans represent sub-operations.

```
Trace: gmail-sync → memory-extraction → llm-worker → memory_records
│
├─ Span: gmail-sync (server)
│  ├─ Span: google_api_fetch (client)           duration: 1200ms
│  ├─ Span: email_upsert (client→postgres)      duration: 45ms
│  └─ Span: enqueue_extraction (producer)        duration: 8ms
│     └─ creates llm_jobs row with trace_id = X
│
├─ Span: llm-worker drain (server)              trace_id = X  (read from job payload)
│  ├─ Span: claim_job (client→postgres)          duration: 3ms
│  ├─ Span: llm_extraction (client→llm)          duration: 2400ms
│  │  ├─ Event: prompt_tokens=1200
│  │  └─ Event: completion_tokens=80
│  ├─ Span: llm_verification (client→llm)        duration: 1800ms
│  ├─ Span: embedding_generation (client→llm)    duration: 400ms
│  ├─ Span: dedup_check (client→postgres)        duration: 12ms
│  ├─ Span: memory_upsert (client→postgres)      duration: 8ms
│  └─ Span: enqueue_consolidation (producer)     duration: 5ms
│
└─ Span: retrieve-context (server)              (separate trace, different causal chain)
   ├─ Span: embedding_generation (client→llm)    duration: 350ms
   ├─ Span: hybrid_search_memories (client→pg)   duration: 18ms
   ├─ Span: hybrid_search_emails (client→pg)     duration: 12ms
   ├─ Span: graph_expand (client→pg)             duration: 8ms
   ├─ Span: ranking (internal)                    duration: 2ms
   └─ Span: assembly (internal)                   duration: 1ms
```

### 5.2 Integration points

Every edge function's entry point wraps the handler in a root span. Key sub-spans:

| Function | Spans |
|---|---|
| `retrieve-context` | `embedding_generation`, `hybrid_search_memories`, `hybrid_search_emails`, `hybrid_search_events`, `graph_expand`, `ranking`, `assembly`, `reinforcement_write` |
| `llm-worker` | `claim_job`, `process_extraction`, `process_briefing`, `process_embedding`, `llm_extraction`, `llm_verification`, `llm_tiebreaker`, `llm_dedup`, `embedding_generation`, `memory_upsert`, `entity_upsert`, `dedup_candidate_search`, `enqueue_consolidation` |
| `gmail-sync` | `google_api_fetch`, `token_refresh`, `email_upsert`, `record_sync_error`, `enqueue_extraction` |
| `calendar-sync` | `google_api_fetch`, `token_refresh`, `event_upsert`, `record_sync_error`, `enqueue_extraction` |
| `slack-sync` | `slack_api_fetch`, `message_upsert` |
| `notion-sync` | `notion_api_fetch`, `page_upsert` |
| `generate-briefing` | `enqueue_briefing_job` |
| `llm-worker:briefing` | `llm_draft`, `llm_verify`, `briefing_upsert`, `enqueue_insights` |
| OAuth exchanges | `oauth_state_lookup`, `provider_token_exchange`, `token_save`, `account_upsert` |

### 5.3 Trace querying

Example: "Show me the full trace for this slow retrieval"

```sql
WITH RECURSIVE span_tree AS (
  SELECT *, 0 AS depth
  FROM traces
  WHERE trace_id = '...' AND parent_span_id IS NULL

  UNION ALL

  SELECT t.*, st.depth + 1
  FROM traces t
  JOIN span_tree st ON t.parent_span_id = st.span_id
)
SELECT
  repeat('  ', depth) || service || '/' || operation AS display,
  duration_ms, status, status_message
FROM span_tree
ORDER BY started_at;
```

Example: "Which operation has the highest p95 latency this hour?"

```sql
SELECT
  service, operation,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
  count(*) AS calls
FROM traces
WHERE started_at > now() - INTERVAL '1 hour'
  AND duration_ms IS NOT NULL
GROUP BY service, operation
ORDER BY p95 DESC;
```

---

## 6. Metrics: pre-aggregated time-series

### 6.1 Aggregation pipeline

```
Raw telemetry tables
  (retrieval_runs, llm_jobs, cost_events, provider_health, memory_extraction_logs,
   memory_merge_audit, connected_accounts, rate_limits, usage_counters, briefings)
        │
        ▼  [pg_cron: every 60s → metrics-aggregator edge function]
        │
metrics_snapshot
  (one row per metric_name + labels + window)
        │
        ▼  [pg_cron: every 5min → refresh_dashboard_cache RPC]
        │
dashboard_cache
  (pre-rendered chart JSON for UI)
```

### 6.2 Key metrics definitions

**Retrieval health:**
```sql
-- retrieval_error_rate (per minute)
SELECT
  date_trunc('minute', created_at) AS window_start,
  count(*) FILTER (WHERE stage IS NOT NULL)::float / NULLIF(count(*), 0) AS error_rate
FROM retrieval_runs r
LEFT JOIN retrieval_failures f ON f.run_id = r.id
WHERE r.created_at > now() - INTERVAL '5 minutes'
GROUP BY 1;
```

**Job queue health:**
```sql
-- job_queue_depth (gauge, sampled every 60s)
SELECT
  job_type, status, count(*) AS depth
FROM llm_jobs
WHERE status IN ('pending', 'processing')
GROUP BY job_type, status;

-- job_staleness_max (gauge, max seconds a job has been "processing")
SELECT
  max(EXTRACT(EPOCH FROM (now() - started_at))) AS max_staleness_seconds
FROM llm_jobs
WHERE status = 'processing';
```

**Sync health:**
```sql
-- sync_error_rate (per hour, per provider)
SELECT
  provider,
  count(*) FILTER (WHERE last_sync_error IS NOT NULL) AS errors,
  count(*) AS total_syncs
FROM connected_accounts
WHERE last_synced_at > now() - INTERVAL '1 hour'
GROUP BY provider;
```

**Cost trending:**
```sql
-- cost_per_hour (per provider, per operation)
SELECT
  provider, operation,
  date_trunc('hour', created_at) AS hour,
  sum(cost_estimate) AS total_cost,
  sum(total_tokens) AS total_tokens,
  avg(latency_ms) AS avg_latency
FROM cost_events
WHERE created_at > now() - INTERVAL '24 hours'
GROUP BY provider, operation, hour
ORDER BY hour DESC;
```

### 6.3 Metric retention

| Window | Retention | Purpose |
|---|---|---|
| 1 minute | 24 hours | Real-time dashboards, alert evaluation |
| 5 minutes | 7 days | Short-term trend analysis |
| 1 hour | 90 days | Long-term trend, cost analysis, capacity planning |

Purge via `pg_cron` jobs (mirror `purge_retrieval_telemetry` pattern):
- `purge_metrics_1min`: runs hourly, deletes 1min windows > 24h old
- `purge_metrics_5min`: runs daily, deletes 5min windows > 7d old
- `purge_traces`: runs daily, deletes traces > 7d old

---

## 7. Cost tracking

### 7.1 Instrumenting LLM calls

The current `LLMRouter.execute()` (`_shared/llm-router.ts`) does NOT return token
counts or cost data. Each provider adapter must be extended to extract:

- `usage.prompt_tokens` / `usage.completion_tokens` / `usage.total_tokens` from
  the provider API response (all major providers return this in the response body)
- The actual `model` version string returned by the API (e.g. `gemini-2.5-flash`
  vs the requested model)

### 7.2 Pricing table

Hardcoded in a new `_shared/pricing.ts`:

| Provider | Model | Input $/1K tokens | Output $/1K tokens | Notes |
|---|---|---|---|---|
| `gemini-3.1-flash-lite` | `gemini-2.5-flash-lite` | $0.00001875 | $0.000075 | Fall 2025 pricing; verify quarterly |
| `gpt-oss-120b` (Cerebras) | `llama-3.3-70b` | $0.00015 | $0.00015 | Cerebras pricing |
| `gemma-3-27b` | `gemma-3-27b-it` | $0.000075 | $0.00015 | Groq or Cerebras hosted |
| `nvidia-nim` | varies | $0.00015 | $0.00015 | Conservative estimate |
| `groq-llama-3.1-8b` | `llama-3.1-8b-instant` | $0.00005 | $0.00008 | Groq pricing |
| Gemini embedding | `text-embedding-004` | $0.000025/1K chars | N/A | Embedding pricing is per character, not token |

`cost_estimate = (input_tokens / 1000) * input_price + (output_tokens / 1000) * output_price`.
Embedding cost = `(input_chars / 1000) * embedding_price`.

### 7.3 Cost write path

1. `LLMRouter.execute()` returns `{ content, provider, model, usage: { input_tokens, output_tokens }, latencyMs }`
   (extended signature — backward compatible via optional fields).
2. The caller writes to `cost_events` (fire-and-forget, try/catch wrapped).
3. `provider_health` columns `total_tokens` and `total_cost` are incremented atomically
   via `UPDATE provider_health SET total_tokens = total_tokens + $1, total_cost = total_cost + $2`.
4. `llm_jobs.cost_estimate` and `llm_jobs.token_count` are updated on job completion
   as a rollup of all LLM calls within the job.

---

## 8. Alerts

### 8.1 Standard alert catalogue

Shipped as seed data in the migration (INSERTs into `alerts`).

| Alert name | Severity | Condition | Cooldown | Rationale |
|---|---|---|---|---|
| `sync_failure_gmail` | **critical** | `consecutive_failures >= 3` for any Gmail connected_account | 30 min | User's email stops syncing silently — highest priority |
| `sync_failure_calendar` | **critical** | `consecutive_failures >= 3` for any Calendar connected_account | 30 min | Calendar data drives deadline extraction |
| `sync_failure_slack` | warning | `consecutive_failures >= 5` for any Slack connected_account | 60 min | Slack is secondary to email/calendar |
| `sync_failure_notion` | warning | `consecutive_failures >= 5` for any Notion connected_account | 60 min | Notion is secondary |
| `job_queue_stalled` | **critical** | `max(EXTRACT(EPOCH FROM (now() - started_at))) > 600` (10 min) for processing jobs | 15 min | Worker is dead or stuck — no new memories, no briefings |
| `job_dead_letter_rate` | warning | dead-lettered jobs in the last hour > 10 | 30 min | Systemic extraction/briefing failures |
| `all_providers_down` | **critical** | `rule-engine` is the only available provider (`cooldown_until > now` on all others) | 5 min | All LLM calls are falling back to rule-engine — quality degraded |
| `single_provider_down` | info | Any single provider `cooldown_until > now` for > 10 min | 30 min | Early warning before all-providers-down |
| `high_retrieval_error_rate` | warning | `retrieval_error_rate > 0.10` (10% of retrievals failing) | 15 min | User-facing impact |
| `high_retrieval_latency` | warning | `retrieval_latency_p95 > 5000ms` sustained for 3 consecutive 5min windows | 15 min | User-facing slowness |
| `quota_near_exhaustion` | info | User's daily AI query usage > 80% of plan limit | Daily | Give user a heads-up before hitting the limit |
| `cost_spike` | warning | LLM cost in the last hour > 3× the hourly average of the last 7 days | 30 min | Unusual LLM usage pattern (bug or abuse) |
| `embedding_generation_failing` | warning | Embedding failure rate > 0.25 | 15 min | Text-only fallback degrades retrieval quality |

### 8.2 Alert evaluation

A new edge function `metrics-aggregator` (invoked by pg_cron every 60s) also runs
alert evaluation:

1. SELECT all `enabled` alerts from `alerts`.
2. Execute each `metric_query`.
3. Check `condition` against the result.
4. If condition met and cooldown elapsed:
   - INSERT into `alert_history` with `state='firing'`.
   - Set `notified=false`.
5. If condition NOT met and alert was previously firing:
   - UPDATE `alert_history` SET `state='resolved'`, `resolved_at=now()`.
6. Log all transitions to stdout (structured JSON, picked up by Supabase log viewer).

### 8.3 Notification delivery

**v1 (in-scope):** Write alert transitions to `alert_history` and to structured log
entries (level=`error` for critical, `warn` for warning, `info` for info). The
Supabase Dashboard log viewer is the primary consumption surface. The Cyrus admin UI
reads `alert_history` for a "System Health" tile.

**v2 (deferred):** Slack webhook integration. The `notify_alerts` edge function reads
`alert_history WHERE notified=false`, sends to a configured Slack webhook URL
(stored as a Vault secret or env var), then sets `notified=true`. Same pattern for
email (SMTP via a Supabase Edge Function).

---

## 9. Dashboards

### 9.1 Dashboard architecture

Dashboards are SQL-driven. `dashboard_cache` stores pre-computed data for each tile.
A pg_cron job refreshes all tiles every 5 minutes. The React admin UI reads
`dashboard_cache` with a simple `supabase.from('dashboard_cache').select('*')` query
— no heavy aggregation at page load time.

### 9.2 Dashboard sections and tiles

#### Section 1: System Overview (home)

| Tile | Viz | Query |
|---|---|---|
| Retrieval Health | Big number (error rate %) + sparkline | `retrieval_error_rate` last 24h |
| Job Queue Depth | Big number (pending count) + by-type breakdown | `job_queue_depth` gauge |
| Active Alerts | Table (severity, name, firing_since) | `alert_history WHERE state='firing'` |
| LLM Cost Today | Big number ($) + sparkline | sum(`cost_events`) today |
| Providers Online | Traffic light (green/yellow/red per provider) | `provider_health.cooldown_until` |

#### Section 2: Retrieval

| Tile | Viz | Query |
|---|---|---|
| Latency (p50/p95/p99) | Timeseries (24h) | `retrieval_latency_ms` from `metrics_snapshot` |
| Throughput (req/min) | Timeseries (24h) | `retrieval_throughput` |
| Error rate by stage | Stacked bar (24h) | `retrieval_failures` by stage |
| Candidates vs Included | Timeseries (24h) | `retrieval_candidates_total` vs `retrieval_included_total` |
| Top queries (by count) | Table | `retrieval_logs` GROUP BY query |
| Feedback ratio (up/down) | Big number + trend | `retrieval_evaluations` rating counts |

#### Section 3: Memory Pipeline

| Tile | Viz | Query |
|---|---|---|
| Extraction throughput | Timeseries (memories created/hr) | `extraction_count` by decision |
| Verification outcomes | Pie (approve/reject/modified/uncertain) | `memory_extraction_logs` by decision |
| Dedup merge rate | Timeseries (merges/hr) | `dedup_merge_count` |
| Average confidence | Timeseries (24h) | `extraction_confidence_avg` |
| Memories by category | Bar chart | `memory_records` GROUP BY category |

#### Section 4: Job Queue

| Tile | Viz | Query |
|---|---|---|
| Queue depth by type | Timeseries (24h) | `job_queue_depth` per job_type |
| Processing rate | Timeseries (jobs completed/min) | `job_processing_rate` |
| Failure rate | Timeseries (failed/min) | `job_failure_rate` |
| Staleness heatmap | Heatmap (hour × job_type) | `job_staleness_max_seconds` |
| Dead-letter log | Table (last 50) | `llm_jobs WHERE status='permanently_failed'` |

#### Section 5: Sync Health

| Tile | Viz | Query |
|---|---|---|
| Sync success rate | Timeseries by provider (24h) | `sync_success_count` vs `sync_error_count` |
| Broken connections | Table (account, error, since) | `connected_accounts WHERE status='broken' OR consecutive_failures >= 3` |
| Last sync times | Table | `connected_accounts` last_synced_at |
| Sync latency | Timeseries (function duration) | From sync function spans in `traces` |

#### Section 6: Providers & Cost

| Tile | Viz | Query |
|---|---|---|
| Cost by provider (today) | Stacked bar | `cost_events` GROUP BY provider |
| Cost by operation (today) | Stacked bar | `cost_events` GROUP BY operation |
| Cost trend (7 days) | Timeseries | `cost_events` daily rollup |
| Token usage by provider | Timeseries | `cost_events` GROUP BY provider, hour |
| Provider latency (p95) | Timeseries | `llm_call_latency_ms` by provider |
| Provider health history | Heatmap | `provider_health` sampled over time (from `metrics_snapshot`) |
| Projected monthly cost | Big number | 30 × daily average |

#### Section 7: System

| Tile | Viz | Query |
|---|---|---|
| Rate limit hits | Timeseries by function | `rate_limit_hit_count` |
| Quota exhaustion events | Table | `quota_exhaustion_count` |
| Connected users (active today) | Big number | `count(DISTINCT user_id)` from `retrieval_runs` today |
| Database size estimate | Big number | `pg_database_size()` / `pg_table_size()` per table |
| Edge function invocations | Timeseries | From `traces` GROUP BY service |

### 9.3 Dashboard SQL views (delivered as migration)

Each dashboard tile is backed by a SQL view or a materialized view. Views are
created in the migration and referenced by the dashboard UI. Examples:

```sql
-- dashboard_retrieval_latency_24h (materialized view, refreshed every 5min)
CREATE MATERIALIZED VIEW dashboard_retrieval_latency_24h AS
SELECT
  window_start,
  p50, p95, p99,
  count AS sample_count
FROM metrics_snapshot
WHERE metric_name = 'retrieval_latency_ms'
  AND window_seconds = 300
  AND window_start > now() - INTERVAL '24 hours'
ORDER BY window_start;

-- dashboard_provider_cost_7d
CREATE MATERIALIZED VIEW dashboard_provider_cost_7d AS
SELECT
  provider,
  date_trunc('day', created_at) AS day,
  sum(cost_estimate) AS total_cost,
  sum(total_tokens) AS total_tokens,
  count(*) AS call_count
FROM cost_events
WHERE created_at > now() - INTERVAL '7 days'
GROUP BY provider, day
ORDER BY day DESC, total_cost DESC;
```

A single RPC `refresh_dashboard_cache()` runs all `REFRESH MATERIALIZED VIEW CONCURRENTLY`
statements, called by pg_cron every 5 minutes.

---

## 10. Files to modify / create

### 10.1 New files

| File | Purpose |
|---|---|
| `supabase/functions/_shared/trace.ts` | Trace context propagation + span API |
| `supabase/functions/_shared/metrics.ts` | In-request metric buffering API |
| `supabase/functions/_shared/pricing.ts` | Provider pricing table for cost computation |
| `supabase/functions/metrics-aggregator/index.ts` | pg_cron-invoked function: aggregates raw telemetry → metrics_snapshot, evaluates alerts, refreshes dashboard_cache |
| `supabase/functions/notify-alerts/index.ts` | (v2) Slack webhook / email delivery for firing alerts |
| `supabase/migrations/038_observability_platform.sql` | All schema changes (§3) |
| `supabase/migrations/039_dashboard_views.sql` | Materialized views for dashboards (§9) |
| `supabase/migrations/040_alert_definitions.sql` | Seed data: standard alert catalogue (§8.1) |
| `supabase/migrations/041_schedule_observability.sql` | pg_cron schedules for aggregator, dashboard refresh, purge jobs |
| `scripts/setup-observability.sql` | Vault secrets provisioning + cron activation (mirrors `setup-worker.sql` pattern) |
| `src/pages/admin/Dashboard.jsx` | (optional v2) React admin dashboard UI consuming `dashboard_cache` |
| `src/pages/admin/Alerts.jsx` | (optional v2) Alert history viewer |

### 10.2 Modified files

| File | Change | Impact |
|---|---|---|
| `supabase/functions/_shared/log.ts` | Add timestamp, stack trace capture, level filtering, trace context injection | Backward compatible; all 15 existing call sites unchanged |
| `supabase/functions/_shared/llm-router.ts` | Return `usage` + `model` from provider adapters; write `cost_events` rows; update `provider_health` token/cost columns | New return fields are optional; existing callers ignore them |
| `supabase/functions/retrieve-context/index.ts` | Create root span via `startSpan`; wrap each stage in a child span; set trace_id on `retrieval_runs`; add cost_event for embedding call | Adds ~15 lines of instrumentation; existing telemetry path unchanged |
| `supabase/functions/llm-worker/index.ts` | Create root span per job; wrap LLM calls in child spans; write `cost_events` for each LLM call; set `llm_jobs.trace_id` + `token_count` + `cost_estimate`; set `memory_records.extraction_job_id` + `extraction_trace_id` | ~30 lines new instrumentation; existing job dispatch path unchanged |
| `supabase/functions/gmail-sync/index.ts` | Wrap in span tree; write `cost_events` for any LLM calls (none currently, but future-proof); increment `consecutive_failures` on sync error; reset on success | ~10 lines; existing sync logic unchanged |
| `supabase/functions/calendar-sync/index.ts` | Same as gmail-sync | ~10 lines |
| `supabase/functions/slack-sync/index.ts` | Wrap in span tree; add `recordSyncError` call (currently missing — fixes observability gap) | ~8 lines |
| `supabase/functions/notion-sync/index.ts` | Same as slack-sync | ~8 lines |
| `supabase/functions/memory-extraction/index.ts` | Propagate `trace_id` into `llm_jobs.payload` when enqueuing | ~3 lines |
| `supabase/functions/generate-briefing/index.ts` | Same trace propagation as memory-extraction | ~3 lines |
| `supabase/functions/health/index.ts` | Add alert summary to response (count of firing alerts) | ~5 lines; backward compatible |
| `supabase/functions/system-validation/index.ts` | Include alert status and cost metrics in validation output; add test9_ObservabilityHealth | ~20 lines; existing tests unchanged |
| `supabase/config.toml` | Add `metrics-aggregator` and `notify-alerts` to function config with `verify_jwt=false` (authenticated by `x-worker-secret` for cron) | Additive |

### 10.3 Files NOT modified

- `supabase/functions/_shared/cors.ts` — no observability concerns
- `supabase/functions/_shared/prompts.ts` — pure text, no runtime behavior
- `supabase/functions/_shared/validators.ts` — pure validation, no runtime behavior
- `supabase/functions/_shared/plans.ts` — quota logic, not observability (quota exhaustion is tracked by reading `usage_counters` from SQL, not from within this module)
- `supabase/functions/_shared/query-parser.ts` — pure parsing, no side effects
- `supabase/functions/_shared/temporal.ts` — pure date math
- `supabase/functions/_shared/rateLimit.ts` — rate limit hits already tracked in `rate_limits` table; no instrumentation change needed
- All OAuth exchange functions — can be traced later; not in the critical path for the initial platform
- `supabase/functions/stripe-webhook/index.ts` — billing observability is a separate concern (Stripe Dashboard already covers it)

---

## 11. Migration plan

### 11.1 Migration 038 — `038_observability_platform.sql`

Creates the observability core:

1. New tables: `traces`, `metrics_snapshot`, `cost_events`, `alerts`, `alert_history`, `dashboard_cache` — `CREATE TABLE IF NOT EXISTS`, RLS enabled, per-user policies for user-scoped data (`traces.user_id`, `cost_events.user_id`), service-role for aggregate data.
2. Enhanced columns on existing tables: `provider_health` (+5 columns), `llm_jobs` (+3), `briefings` (+3), `retrieval_runs` (+1), `connected_accounts` (+2), `memory_records` (+2) — all `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
3. Indexes for all new tables and new columns.
4. RPCs: `record_cost_event(...)`, `record_trace_span(...)`, `flush_trace_spans(...)`, `evaluate_alerts()`, `refresh_dashboard_cache()`.
5. Idempotent: all DDL wrapped in `IF NOT EXISTS` / `IF EXISTS` guards. Safe under `db reset`.

### 11.2 Migration 039 — `039_dashboard_views.sql`

Materialized views for each dashboard tile. `CREATE MATERIALIZED VIEW IF NOT EXISTS`.
A `refresh_all_dashboard_views()` RPC that runs all `REFRESH MATERIALIZED VIEW CONCURRENTLY`
statements in order.

### 11.3 Migration 040 — `040_alert_definitions.sql`

INSERTs standard alert definitions into `alerts` (`ON CONFLICT (alert_name) DO NOTHING`
for idempotency). These are seed data, not schema — they can be updated without a
migration by modifying the `alerts` table directly.

### 11.4 Migration 041 — `041_schedule_observability.sql`

pg_cron jobs (following the established pattern from
`022_schedule_llm_worker.sql:1-144`):

| Job name | Schedule | Function | Purpose |
|---|---|---|---|
| `metrics-aggregator` | `* * * * *` (every minute) | `metrics-aggregator` | Aggregate raw telemetry → `metrics_snapshot`, evaluate alerts |
| `dashboard-cache-refresh` | `*/5 * * * *` (every 5 min) | `refresh_dashboard_cache()` RPC | Refresh materialized views |
| `purge-metrics-1min` | `7 * * * *` (hourly at :07) | `purge_metrics_1min()` RPC | Delete 1min windows > 24h old |
| `purge-traces` | `13 3 * * *` (daily at 3:13 AM) | `purge_traces()` RPC | Delete traces > 7d old |

All scheduled ONLY if Vault secrets `project_url` + `worker_secret` exist (same guard
as existing cron migrations). `NOTICE` output explains which secrets are missing.

### 11.5 Backfill

No backfill needed. Observability starts recording from the moment the migration is
applied. Historical data in existing telemetry tables is available for ad-hoc query
but is not backfilled into the new metrics/tracing system (the existing tables remain
unchanged and queryable).

---

## 12. Testing strategy

### 12.1 Unit tests (Deno)

| Test | What it validates |
|---|---|
| `trace_span_lifecycle` | span creation → setAttribute → setStatus → end → writes row to traces with correct duration |
| `trace_context_propagation` | `withTraceContext` correctly propagates trace_id/span_id across async boundaries |
| `logger_timestamp` | Every log entry has `@timestamp` field |
| `logger_stack_trace` | `log.error(msg, new Error('boom'))` includes stack in fields |
| `metrics_counter` | `incrementCounter('test', 1)` → `recordHistogram('test', 42)` → flush writes correct rows |
| `cost_estimate_calculation` | Known input/output tokens → correct cost for each provider using pricing.ts |
| `alert_evaluation` | Given metric_query returning value above threshold → alert fires; below → alert resolves |
| `alert_cooldown` | Alert fires, then re-evaluated within cooldown → no duplicate firing |
| `provider_health_cost_rollup` | `updateProviderHealth` increments total_tokens and total_cost correctly |

### 12.2 Integration tests (Deno)

| Test | What it validates |
|---|---|
| `retrieve_context_spans` | A full retrieval produces a trace with ≥8 spans (root + embedding + 3 searches + graph + ranking + assembly) |
| `llm_worker_trace_chain` | job enqueued → worker processes → trace_id chained through llm_jobs.payload → worker span has parent_span_id matching producer |
| `sync_error_consecutive_failures` | Three consecutive sync failures → connected_accounts.consecutive_failures = 3; one success → resets to 0 |
| `cost_event_written_on_llm_call` | LLM extraction → cost_events row with provider, operation, input_tokens, output_tokens, cost_estimate > 0 |
| `dashboard_cache_refresh` | Call refresh_dashboard_cache() → dashboard_cache rows updated with current refreshed_at |
| `metrics_aggregator_run` | Raw retrieval_runs rows → metrics_snapshot has matching rows with correct p50/p95/p99 |

### 12.3 System tests

| Test | What it validates |
|---|---|
| `full_trace_end_to_end` | gmail-sync → memory-extraction enqueue → llm-worker → memory_records inserted — single trace_id across all, spans form a valid parent→child tree |
| `alert_fires_on_broken_sync` | Set connected_accounts.consecutive_failures=3 → metrics-aggregator runs → alert_history has firing row |
| `alert_resolves_on_sync_recovery` | Set consecutive_failures back to 0 → aggregator runs → alert resolved |
| `cost_daily_rollup` | Insert cost_events across 2 days → daily rollup produces correct sums |

### 12.4 CI integration

- `deno test supabase/functions/metrics-aggregator/*.test.ts`
- `deno test tests/observability/*.test.ts` (trace, metrics, cost, alert tests)
- Existing CI gates unchanged: `deno check` on all functions (new ones included),
  `deno test` on all test files, `supabase db reset` validates migrations.

---

## 13. Rollback strategy

**Tier 1 — Feature flag:** `OBSERVABILITY_WRITE_ENABLED` env var. `false` → trace
spans, metrics flushes, and cost_events writes are no-ops (the API calls return
immediately). Existing telemetry tables (`retrieval_runs`, `memory_extraction_logs`,
etc.) continue to work exactly as before. Dashboard queries return empty (no data
in new tables). Alert evaluation skips (no firing). This is the instant lever.

**Tier 2 — Drop the layer:** Down-migration drops all new tables and columns
(`DROP TABLE IF EXISTS ... CASCADE`, `ALTER TABLE ... DROP COLUMN IF EXISTS`).
Existing telemetry is untouched. Logging enhancements are backward-compatible
(the new fields in log entries don't break anything).

**Tier 3 — pg_cron stop:** Remove the observability cron jobs → aggregation
and alert evaluation stop. Raw telemetry continues to accumulate (the write path
is independent of the cron processing path). Dashboard cache goes stale but
doesn't break the UI (it shows the last cached data with a "Last updated: ..."
stale indicator).

---

## 14. Tradeoffs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Metrics storage | **Postgres `metrics_snapshot` table** | Prometheus/InfluxDB/TimescaleDB | No new infrastructure; reuses existing Postgres. SQL aggregation is adequate at Cyrus scale (<1000 req/min). Cost: eventual migration to a TSDB at 10× scale. |
| Trace storage | **Postgres `traces` table** | Jaeger/Tempo/Honeycomb | Same rationale. 7-day retention keeps table size manageable. Cost: no sampling (100% capture) — may need head-based sampling at scale. |
| Dashboard rendering | **Pre-computed `dashboard_cache` matviews** | Live SQL queries on page load | Constant-time page load regardless of raw data volume. Cost: 5-minute staleness on dashboards (acceptable for an admin tool). |
| Alert delivery | **Postgres-backed (log + `alert_history`)** | PagerDuty/Opsgenie native integration | No new services. v1 is human-operated — someone checks the dashboard or log viewer. v2 adds webhook delivery. |
| Cost tracking granularity | **Per LLM call (`cost_events`)** | Per-job rollup, or per-user daily | Call-level enables provider comparison, anomaly detection, and debugging "why is this user's cost spiking?" Cost: more rows. |
| Sync error tracking (slack/notion) | **Fix the gap: add `recordSyncError` to slack/notion syncs** | Leave as-is | TD-001 already documents this as a known bug pattern. The observability platform is the right time to close it. |
| Trace propagation format | **Custom (trace_id UUID + span_id UUID)** | W3C Trace Context (`traceparent` header) | Simpler; no HTTP header parsing needed for cron→pg_net calls. Can adopt W3C later at the edge boundary only. |
| Embedding cost tracking | **Per-character pricing in `cost_events`** | Token-based approximation | Embedding APIs price per character, not token. Accuracy matters for cost projections. |
| Provider pricing table | **Hardcoded in `_shared/pricing.ts`** | Database table, or API-fetched | Matches the existing `plans.ts` pattern (hardcoded limits per plan). Update via code change + deploy. Cost: quarterly pricing review needed. |

---

## 15. Implementation phases

**Phase 0 — Schema (038–041) + instrumentation library (`trace.ts`, `metrics.ts`, `pricing.ts`).**
All DDL + new functions created. Instrumentation API available but no callers yet.
Log enhancements deployed (timestamp, stack traces, trace_id injection — backward
compatible). No behavior change. Flag `OBSERVABILITY_WRITE_ENABLED=false`.
*Exit:* `db reset` green, `deno check` on all functions green.

**Phase 1 — Instrument retrieve-context + llm-worker.**
Add spans, cost_events writes, trace_id propagation. Highest-value targets:
these two functions account for 90% of LLM calls and user-facing latency.
`OBSERVABILITY_WRITE_ENABLED=true` for canary users.
*Exit:* `cost_events` and `traces` tables populated; verify from Supabase Dashboard.

**Phase 2 — Instrument sync functions (gmail, calendar, slack, notion).**
Add spans to sync functions. Fix slack/notion `recordSyncError` gap (TD-001).
Add `consecutive_failures` tracking.
*Exit:* Sync traces visible end-to-end; `connected_accounts.consecutive_failures`
correctly tracks sync health.

**Phase 3 — Metrics aggregator + dashboard views (039, 041).**
Deploy `metrics-aggregator` edge function. Schedule via pg_cron. Create dashboard
materialized views. Refresh cycle running.
*Exit:* `metrics_snapshot` populated every 60s; dashboard_cache refreshed every 5min.

**Phase 4 — Alert evaluation (040).**
Seed alert definitions. Activate alert evaluation in the aggregator.
Verify alert_history transitions.
*Exit:* `sync_failure_gmail` fires within 3 minutes of breaking a Gmail connection;
resolves on recovery.

**Phase 5 — Admin UI (optional v2).**
React admin pages consuming `dashboard_cache` + `alert_history`. System health
tile on the main dashboard. Cost breakdown and trends.
*Exit:* Admin can view all dashboards without writing SQL.

**Phase 6 — Notification delivery (optional v2).**
Slack webhook integration via Vault secret. `notify-alerts` edge function.
*Exit:* Critical alerts arrive in Slack within 5 minutes of firing.

---

## 16. Worked example: end-to-end trace

A user asks *"what's blocking xConnect?"* at 09:15:03 UTC.

```
Trace ID: a1b2c3d4-...

09:15:03.100  Span[0] retrieve-context / server (root)
09:15:03.101  ├─ Span[1] embedding_generation / client    [llm call to gemini]
09:15:03.450  │  └─ end: duration=349ms, tokens=15, cost=$0.0000004
09:15:03.451  ├─ Span[2] hybrid_search_memories / client  [pg RPC]
09:15:03.469  │  └─ end: duration=18ms, candidates=30
09:15:03.470  ├─ Span[3] hybrid_search_emails / client
09:15:03.481  │  └─ end: duration=11ms, candidates=20
09:15:03.482  ├─ Span[4] hybrid_search_events / client
09:15:03.491  │  └─ end: duration=9ms, candidates=10
09:15:03.492  ├─ Span[5] graph_expand / client
09:15:03.500  │  └─ end: duration=8ms, expanded=15
09:15:03.501  ├─ Span[6] ranking / internal
09:15:03.503  │  └─ end: duration=2ms, ranked=65
09:15:03.504  ├─ Span[7] assembly / internal
09:15:03.506  │  └─ end: duration=2ms, included=11
09:15:03.507  ├─ Span[8] reinforcement_write / client
09:15:03.511  │  └─ end: duration=4ms, reinforced=6
09:15:03.512  root span end: total=412ms, status=ok

Cost events written:
  - provider=gemini-3.1-flash-lite, operation=embedding, tokens=15, cost=$0.0000004
  - (no other LLM calls in this retrieval)

Metrics flushed:
  - retrieval_latency_ms=412
  - retrieval_candidates_total=65
  - retrieval_included_total=11
  - llm_call_count{provider=gemini}=1
  - retrieval_throughput=1
```

A minute later, the metrics aggregator runs and produces `metrics_snapshot` rows
for this window. Five minutes later, the dashboard cache refreshes and the latency
sparkline on the admin dashboard includes this data point.

---

**File written:** `D:\cyrus v2\docs\superpowers\specs\2026-06-23-observability-platform-design.md`
