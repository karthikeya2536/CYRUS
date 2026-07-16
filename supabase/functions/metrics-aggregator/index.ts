import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Note: Quality baseline metrics (recall@5, mrr, ndcg10, etc.) are NOT computed
// here. They are evaluated by the deploy-time benchmark in
// supabase/functions/retrieve-context/eval/ using the shared engine from
// supabase/functions/_shared/graph_eval/. That script stores results in
// metrics_snapshot as quality_*_baseline entries — see docs/ops/actionable-metrics-runbook.md.
//
// This aggregator focuses exclusively on runtime operational metrics:
// latency, queue depth, failure rates, dead letters, and throughput.

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// ── helpers ──────────────────────────────────────────────────────────────────

/** Compute percentiles from a sorted array of numbers. */
function percentiles(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function snapshot(
  metric_name: string,
  labels: Record<string, string>,
  window_start: string,
  values: number[],
  extra?: Record<string, unknown>,
) {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    metric_name,
    labels,
    window_start,
    window_seconds: 60,
    value: sum / count,
    count,
    min_val: values[0],
    max_val: values[count - 1],
    p50: percentiles(values, 0.5),
    p95: percentiles(values, 0.95),
    p99: percentiles(values, 0.99),
    ...extra,
  };
}

function scalarSnapshot(
  metric_name: string,
  labels: Record<string, string>,
  window_start: string,
  value: number,
  count?: number,
) {
  return {
    metric_name,
    labels,
    window_start,
    window_seconds: 60,
    value,
    count: count ?? 1,
  };
}

// ── main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  try {
    const { data: checkpoint } = await supabaseAdmin
      .from('aggregation_checkpoints')
      .select('last_processed_at')
      .eq('id', 'metrics_aggregator')
      .maybeSingle();

    if (!checkpoint) {
      return new Response(JSON.stringify({ error: "Missing checkpoint" }), { status: 500 });
    }

    const windowStart = checkpoint.last_processed_at;
    const now = new Date();
    now.setSeconds(0, 0);
    const windowEnd = now.toISOString();

    if (new Date(windowStart) >= new Date(windowEnd)) {
      return new Response(JSON.stringify({ success: true, msg: "Already processed" }), { status: 200 });
    }

    const snapshots: Record<string, unknown>[] = [];

    // ── 1. Trace latency per operation (existing) ──────────────────────────
    const { data: traces } = await supabaseAdmin
      .from('traces')
      .select('operation, duration_ms, status')
      .gte('started_at', windowStart)
      .lt('started_at', windowEnd)
      .not('duration_ms', 'is', null);

    if (traces && traces.length > 0) {
      const ops: Record<string, number[]> = {};
      const opStatus: Record<string, { ok: number; error: number }> = {};
      for (const t of traces) {
        if (!ops[t.operation]) { ops[t.operation] = []; opStatus[t.operation] = { ok: 0, error: 0 }; }
        ops[t.operation].push(t.duration_ms);
        if (t.status === 'error' || t.status === 'unset') {
          opStatus[t.operation].error++;
        } else {
          opStatus[t.operation].ok++;
        }
      }

      for (const [op, durations] of Object.entries(ops)) {
        const s = snapshot('trace_latency_ms', { operation: op }, windowStart, durations);
        if (s) snapshots.push(s);

        // Error rate per operation
        const st = opStatus[op];
        const total = st.ok + st.error;
        if (total > 0) {
          snapshots.push(scalarSnapshot(
            'trace_error_rate',
            { operation: op },
            windowStart,
            st.error / total,
            total,
          ));
        }
      }

      // ── 1a. Dedicated graph_latency_p95 metric for alerting ─────────────
      const graphDurations = ops['graph_render_relations'];
      if (graphDurations && graphDurations.length > 0) {
        const s = snapshot('graph_latency_p95', {}, windowStart, graphDurations);
        if (s) snapshots.push(s);
      }

      // ── 1b. Dedicated omniroute_latency_p95 from traces ─────────────────
      // LLM calls passing through OmniRoute are traced as operations like
      // 'llm_call', 'generate_embedding', etc.
      const llmOps = ['llm_call', 'generate_embedding', 'extract_memory', 'classify_intent',
        'rank_candidates', 'generate_briefing'];
      for (const llmOp of llmOps) {
        const durs = ops[llmOp];
        if (durs && durs.length > 0) {
          const s = snapshot('omniroute_latency_p95', { operation: llmOp }, windowStart, durs);
          if (s) snapshots.push(s);
        }
      }
    }

    // ── 2. Cost + token aggregation (existing) ────────────────────────────
    const { data: costs } = await supabaseAdmin
      .from('cost_events')
      .select('provider, model, cost_estimate, total_tokens, latency_ms')
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    if (costs && costs.length > 0) {
      const providers: Record<string, { cost: number; tokens: number; count: number; latencies: number[] }> = {};
      for (const c of costs) {
        const key = `${c.provider}::${c.model}`;
        if (!providers[key]) {
          providers[key] = { cost: 0, tokens: 0, count: 0, latencies: [] };
        }
        providers[key].cost += (c.cost_estimate || 0);
        providers[key].tokens += (c.total_tokens || 0);
        providers[key].count += 1;
        if (c.latency_ms) providers[key].latencies.push(c.latency_ms);
      }

      for (const [key, agg] of Object.entries(providers)) {
        const [provider, model] = key.split('::');
        snapshots.push(scalarSnapshot('llm_cost_estimate', { provider, model }, windowStart, agg.cost, agg.count));
        snapshots.push(scalarSnapshot('llm_tokens_total', { provider, model }, windowStart, agg.tokens, agg.count));

        // Per-provider latency p95
        if (agg.latencies.length > 0) {
          const s = snapshot('omniroute_latency_p95', { provider, model }, windowStart, agg.latencies);
          if (s) snapshots.push(s);
        }
      }
    }

    // ── 3. Queue depth (pending jobs) ─────────────────────────────────────
    const { data: pendingByType } = await supabaseAdmin
      .from('llm_jobs')
      .select('job_type')
      .eq('status', 'pending');

    if (pendingByType) {
      const byType: Record<string, number> = {};
      for (const j of pendingByType) {
        byType[j.job_type] = (byType[j.job_type] || 0) + 1;
      }
      const totalPending = pendingByType.length;
      snapshots.push(scalarSnapshot('llm_queue_depth', { job_type: '*' }, windowStart, totalPending));
      for (const [jt, count] of Object.entries(byType)) {
        snapshots.push(scalarSnapshot('llm_queue_depth', { job_type: jt }, windowStart, count));
      }
    }

    // ── 4. Dead-letter rate (permanently_failed jobs) ─────────────────────
    const { data: deadLetters } = await supabaseAdmin
      .from('llm_jobs')
      .select('job_type')
      .eq('status', 'permanently_failed')
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    if (deadLetters) {
      const byType: Record<string, number> = {};
      for (const j of deadLetters) {
        byType[j.job_type] = (byType[j.job_type] || 0) + 1;
      }
      const totalDead = deadLetters.length;
      snapshots.push(scalarSnapshot('llm_dead_letter_rate', { job_type: '*' }, windowStart, totalDead));
      for (const [jt, count] of Object.entries(byType)) {
        snapshots.push(scalarSnapshot('llm_dead_letter_rate', { job_type: jt }, windowStart, count));
      }
    }

    // ── 5. Embedding / retrieval failure rate ─────────────────────────────
    const { count: embeddingFailures, error: efErr } = await supabaseAdmin
      .from('retrieval_failures')
      .select('*', { count: 'exact', head: true })
      .eq('stage', 'embedding')
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    const { count: retrievalFailuresAll, error: rfErr } = await supabaseAdmin
      .from('retrieval_failures')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    const { count: totalRetrievals, error: trErr } = await supabaseAdmin
      .from('retrieval_runs')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    const efCount = efErr ? 0 : (embeddingFailures ?? 0);
    const rfCount = rfErr ? 0 : (retrievalFailuresAll ?? 0);
    const trCount = trErr ? 0 : (totalRetrievals ?? 1);

    snapshots.push(scalarSnapshot('retrieval_embedding_failure_count', {}, windowStart, efCount));
    if (trCount > 0) {
      snapshots.push(scalarSnapshot(
        'retrieval_embedding_failure_rate',
        {},
        windowStart,
        efCount / trCount,
        trCount,
      ));
      snapshots.push(scalarSnapshot(
        'retrieval_failure_rate',
        { stage: '*' },
        windowStart,
        rfCount / trCount,
        trCount,
      ));
    }

    // ── 5b. Failure rate by stage ─────────────────────────────────────────
    if (rfCount > 0) {
      const { data: failuresByStage } = await supabaseAdmin
        .from('retrieval_failures')
        .select('stage')
        .gte('created_at', windowStart)
        .lt('created_at', windowEnd);

      if (failuresByStage) {
        const stageCounts: Record<string, number> = {};
        for (const f of failuresByStage) {
          stageCounts[f.stage] = (stageCounts[f.stage] || 0) + 1;
        }
        for (const [stage, count] of Object.entries(stageCounts)) {
          snapshots.push(scalarSnapshot(
            'retrieval_failure_rate',
            { stage },
            windowStart,
            count / trCount,
            trCount,
          ));
        }
      }
    }

    // ── 6. Retrieval latency p95 (end-to-end) ────────────────────────────
    const { data: retrievalRuns } = await supabaseAdmin
      .from('retrieval_runs')
      .select('latency_ms, intent')
      .not('latency_ms', 'is', null)
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    if (retrievalRuns && retrievalRuns.length > 0) {
      const latencies = retrievalRuns.map(r => r.latency_ms);
      const s = snapshot('retrieval_latency_p95', {}, windowStart, latencies);
      if (s) snapshots.push(s);

      // Per-intent latencies
      const byIntent: Record<string, number[]> = {};
      for (const r of retrievalRuns) {
        const intent = r.intent || 'unknown';
        if (!byIntent[intent]) byIntent[intent] = [];
        byIntent[intent].push(r.latency_ms);
      }
      for (const [intent, durs] of Object.entries(byIntent)) {
        const s = snapshot('retrieval_latency_p95', { intent }, windowStart, durs);
        if (s) snapshots.push(s);
      }
    }

    // ── Bulk insert ───────────────────────────────────────────────────────
    if (snapshots.length > 0) {
      // Batch in chunks of 50 to avoid payload limits
      for (let i = 0; i < snapshots.length; i += 50) {
        const batch = snapshots.slice(i, i + 50);
        const { error } = await supabaseAdmin.from('metrics_snapshot').insert(batch);
        if (error) {
          console.error(`metrics-aggregator insert error (batch ${i}):`, error);
        }
      }
    }

    await supabaseAdmin
      .from('aggregation_checkpoints')
      .update({ last_processed_at: windowEnd })
      .eq('id', 'metrics_aggregator');

    return new Response(JSON.stringify({
      success: true,
      snapshots: snapshots.length,
      traces: traces?.length || 0,
      costs: costs?.length || 0,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error("metrics-aggregator error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
