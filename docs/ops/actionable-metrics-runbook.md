# Actionable Metrics Runbook

Every metric below is designed to be **actionable** — each one maps to a specific
collection point, a threshold that triggers attention, and a concrete operational
response. No metric here exists "to be interesting."

## Alert Channels

Currently alert thresholds are checked by the `/health` endpoint. Plans for
push-based alerting (email/Slack webhook) are tracked in the roadmap.

## Quality Metrics (separate from operational)

Quality metrics (recall@5, MRR, nDCG@10, generic edge ratio, dependency/people
top-1/top-5) are **not** computed by the live metrics aggregator. They are
regression-benchmark values evaluated:

- **On every deploy** (CI runs `deno test graph-eval.test.ts`)
- **Nightly** against the production dataset
- **Manually** before releases

These are stored in `metrics_snapshot` with the prefix `quality_*_baseline` to
distinguish them from live operational metrics. To trigger a manual evaluation:

```bash
# Requires DATABASE_URL pointing at the target Supabase project
deno run --allow-read --allow-net --allow-env \
  supabase/functions/retrieve-context/eval/store-quality-metrics.ts
```

**Implementation:** The graph evaluation engine lives in a single shared location
(`supabase/functions/_shared/graph_eval/`) imported by both the CI test suite
and the deploy-time benchmark script. There is no duplication.

---

## 1. Queue Depth

| Field | Value |
|---|---|
| **Metric** | `llm_queue_depth` — pending jobs in `llm_jobs` |
| **Collection** | `metrics-aggregator` (1-min window) queries `llm_jobs WHERE status = 'pending'` |
| **Threshold** | >100 pending jobs sustained for 5+ minutes |
| **Severity** | Warn → Investigate |
| **Why it matters** | >100 means jobs are arriving faster than the worker can drain them. If sustained, users experience delayed memories, missing briefings, and stale data. |

### Operational Response

1. **Check worker health:**
   ```
   SELECT cron.job_name, last_run, last_successful_run
   FROM cron.job_run_details
   WHERE job_name LIKE '%worker%'
   ORDER BY last_run DESC LIMIT 5;
   ```
   If the worker hasn't run recently, restart pg_cron or check the `llm-worker` deployment.

2. **Identify what's stuck:**
   ```
   SELECT job_type, priority, count(*), min(created_at) as oldest
   FROM llm_jobs WHERE status = 'pending'
   GROUP BY job_type, priority ORDER BY count(*) DESC;
   ```
   If one job type dominates (e.g. `generate_embedding`), that sub-system is the bottleneck.

3. **Check for hung processing jobs (stuck for >5 min):**
   ```
   SELECT id, job_type, started_at, attempts
   FROM llm_jobs WHERE status = 'processing' AND started_at < now() - interval '5 minutes';
   ```
   The worker reclaims these automatically, but if they keep appearing, the worker is crashing mid-job.

4. **Scale if needed:** If sustained >200 for >15 minutes, increase worker concurrency
   (`MAX_JOBS_PER_RUN` in `llm-worker/index.ts`) or deploy a second worker instance.

---

## 2. Graph Latency p95

| Field | Value |
|---|---|
| **Metric** | `graph_latency_p95` — `graph_render_relations` RPC duration |
| **Collection** | OpenTelemetry `traces` table via `trace.ts` span instrumentation; aggregated by `metrics-aggregator` |
| **Threshold** | p95 > 500 ms |
| **Severity** | Warn → Optimize |
| **Why it matters** | Graph rendering is on the critical path of every retrieval query. >500ms p95 means users see slow answers. |

### Operational Response

1. **Profile the RPC:**
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM graph_render_relations(
     start_keys := ARRAY['...'],
     max_hops := 2,
     p_hop_decay := 0.8,
     p_intent := 'general'
   );
   ```
   Look for sequential scans or missing indexes.

2. **Check index coverage:**
   ```sql
   SELECT schemaname, tablename, indexname, indexdef
   FROM pg_indexes
   WHERE tablename = 'knowledge_graph_edges';
   ```
   The RPC filters by `(source, relationship, target, confidence)`. If no composite
   index exists on `(source, relationship, target)`, add one:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kge_source_rel_target
   ON knowledge_graph_edges(source, relationship, target)
   WHERE confidence >= 2;
   ```

3. **Check for large fan-out nodes:** If a single start node has >1000 edges,
   the BFS expands explosively. Identify these:
   ```sql
   SELECT source, count(*) as edge_count
   FROM knowledge_graph_edges
   GROUP BY source ORDER BY count(*) DESC LIMIT 10;
   ```
   Consider pruning low-confidence edges or increasing the quality_score gate.

4. **If p95 > 1000 ms (critical):** Degrade gracefully by reducing `MAX_HOPS` to 1
   temporarily, or increasing `QUALITY_THRESHOLD` to 3 to reduce traversal breadth.

---

## 3. OmniRoute Latency p95

| Field | Value |
|---|---|
| **Metric** | `omniroute_latency_p95` — round-trip time for OmniRoute LLM calls |
| **Collection** | `cost_events` or `traces` table; aggregated by `metrics-aggregator` |
| **Threshold** | p95 > 2 s |
| **Severity** | Warn → Fallback |
| **Why it matters** | Every retrieval query makes at least one LLM call (intent classification). Slow OmniRoute means slow everything. |

### Operational Response

1. **Check OmniRoute status:** Navigate to OmniRoute dashboard or:
   ```
   curl -I https://omniroute.example.com/health
   ```
   If OmniRoute is degraded, the LLMRouter should automatically fall back to
   the secondary provider. Verify fallback is working:
   ```
   SELECT provider, count(*)
   FROM cost_events
   WHERE created_at > now() - interval '5 minutes'
   GROUP BY provider;
   ```

2. **Identify which operation is slow:**
   ```
   SELECT operation, avg(latency_ms)::int as avg_ms, count(*)
   FROM cost_events
   WHERE created_at > now() - interval '5 minutes'
   GROUP BY operation ORDER BY avg_ms DESC;
   ```

3. **Verify model selection:** The `classify_intent` operation uses a fast model
   (`haiku`-equivalent) while `memory_extraction` uses a reasoning model. If
   classify_intent is slow, the model routing may be wrong. Check:
   ```
   SELECT operation, model, avg(latency_ms)::int as avg_ms
   FROM cost_events
   WHERE created_at > now() - interval '5 minutes'
   GROUP BY operation, model;
   ```

4. **If p95 > 5 s (critical):** Disable the affected operation in OmniRoute and
   force static fallback (e.g. route `classify_intent` to a local model).

---

## 4. Dead-Letter Jobs

| Field | Value |
|---|---|
| **Metric** | `llm_dead_letter_rate` — `permanently_failed` jobs per hour |
| **Collection** | `metrics-aggregator` queries `llm_jobs WHERE status = 'permanently_failed'` |
| **Threshold** | >10 permanently_failed jobs per hour |
| **Severity** | Warn → Investigate |
| **Why it matters** | Failed jobs mean lost data: memories not extracted, briefings not generated, embeddings not created. |

### Operational Response

1. **Find the failing jobs:**
   ```sql
   SELECT job_type, last_error, count(*) as cnt
   FROM llm_jobs
   WHERE status = 'permanently_failed'
     AND created_at > now() - interval '1 hour'
   GROUP BY job_type, last_error
   ORDER BY cnt DESC;
   ```

2. **Common failure patterns:**
   - `LLM provider error`: OmniRoute returned an error. Check OmniRoute dashboard.
   - `Timeout`: Job exceeded the 60s timeout. Consider increasing timeout for that job type.
   - `Rate limit`: Reduce concurrency or add retry delay.
   - `Payload too large`: The source data exceeds the model context window.

3. **Dead-letter recovery:** Permanently_failed jobs are NOT retried automatically.
   To re-enqueue:
   ```sql
   UPDATE llm_jobs
   SET status = 'pending', attempts = 0, last_error = NULL, started_at = NULL
   WHERE status = 'permanently_failed'
     AND created_at > now() - interval '24 hours'
   LIMIT 50;
   ```

4. **If rate > 50/hour (critical):** The system is systematically failing. Disable
   the affected job type's producer (e.g. pause `memory-extraction` webhook) until
   the root cause is fixed.

---

## 5. Embedding Failure Rate

| Field | Value |
|---|---|
| **Metric** | `retrieval_embedding_failure_rate` — `retrieval_failures WHERE stage = 'embedding'` divided by total `retrieval_runs` |
| **Collection** | `metrics-aggregator` joins `retrieval_failures` and `retrieval_runs` |
| **Threshold** | >1% of retrieval queries |
| **Severity** | Warn → Investigate |
| **Why it matters** | Embedding failures mean the retrieval pipeline returns degraded results (graph-only, no semantic search). Users get worse answers. |

### Operational Response

1. **Check the failure messages:**
   ```sql
   SELECT message, count(*) as cnt
   FROM retrieval_failures
   WHERE stage = 'embedding'
     AND created_at > now() - interval '5 minutes'
   GROUP BY message;
   ```

2. **Check OmniRoute embedding endpoint:**
   ```
   curl -X POST https://omniroute.example.com/v1/embeddings \
     -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model": "text-embedding-3-small", "input": "test"}'
   ```
   If this fails, the embedding model is down.

3. **Check rate limits:** Embedding endpoints often have lower rate limits than
   chat completions. If failures include "rate limit" language:
   ```
   SELECT count(*) FROM retrieval_failures
   WHERE stage = 'embedding'
     AND message ILIKE '%rate%'
     AND created_at > now() - interval '5 minutes';
   ```

4. **If rate > 5% (critical):** Disable embedding-dependent features (semantic
   search falls back to full-text only) and page the provider.

---

## 6. Retrieval End-to-End Latency

| Field | Value |
|---|---|
| **Metric** | `retrieval_latency_p95` — complete `retrieve-context` edge function duration |
| **Collection** | `retrieval_runs.latency_ms`; aggregated by `metrics-aggregator` |
| **Threshold** | p95 > 3 s (soft — depends on query complexity) |
| **Severity** | Info → Investigate if sustained |
| **Why it matters** | E2E latency is the user-perceived metric. The p95 tells you if "most" users get fast answers. |

### Operational Response

1. **Check sub-stage breakdown** — the slowest stage is likely graph rendering or
   OmniRoute calls. Use per-intent latency:
   ```
   SELECT intent, avg(latency_ms)::int as avg_ms, p95
   FROM metrics_snapshot
   WHERE metric_name = 'retrieval_latency_p95'
   ORDER BY window_start DESC LIMIT 10;
   ```

2. **Cross-reference with other metrics:**
   - If `graph_latency_p95` is also high → fix graph rendering (see §2)
   - If `omniroute_latency_p95` is also high → fix OmniRoute (see §3)
   - If both are normal → the bottleneck is in `ranker.ts` or `assembler.ts`

---

## Data Retention

| Table | Retention | Enforcement |
|---|---|---|
| `traces` | 7 days | `trace_retention_job` (cron, 2am daily) |
| `cost_events` | 30 days | `trace_retention_job` (cron, 2am daily) |
| `metrics_snapshot` | 90 days | Manual or scheduled purge |
| `retrieval_runs` | 30 days | `purge_retrieval_telemetry(30)` (cron, 3:17am daily) |
| `retrieval_failures` | 30 days | Cascade from `retrieval_runs` purge |

---

## Dashboard SQL

To build a real-time ops dashboard, query the `metrics_snapshot` table:

```sql
-- Current health overview
SELECT
  metric_name,
  value AS current_value,
  window_start
FROM metrics_snapshot
WHERE metric_name IN (
  'llm_queue_depth',
  'llm_dead_letter_rate',
  'retrieval_embedding_failure_rate',
  'graph_latency_p95',
  'omniroute_latency_p95',
  'retrieval_latency_p95'
)
  AND labels = '{}'::jsonb
ORDER BY window_start DESC
LIMIT 6;
```

```sql
-- Recent trends (last 6 hours, 5-min buckets)
SELECT
  date_trunc('minute', window_start) - interval '1 minute' * (EXTRACT(minute FROM window_start)::int % 5) AS bucket,
  metric_name,
  avg(value) AS avg_value,
  max(p95) AS max_p95
FROM metrics_snapshot
WHERE metric_name = 'graph_latency_p95'
  AND window_start > now() - interval '6 hours'
GROUP BY bucket, metric_name
ORDER BY bucket;
```
