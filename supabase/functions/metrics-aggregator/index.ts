import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

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
    now.setSeconds(0, 0); // truncate to current minute boundary
    const windowEnd = now.toISOString();

    if (new Date(windowStart) >= new Date(windowEnd)) {
      return new Response(JSON.stringify({ success: true, msg: "Already processed" }), { status: 200 });
    }

    // 1. Aggregate traces
    const { data: traces } = await supabaseAdmin
      .from('traces')
      .select('operation, duration_ms')
      .gte('started_at', windowStart)
      .lt('started_at', windowEnd)
      .not('duration_ms', 'is', null);

    if (traces && traces.length > 0) {
      const ops: Record<string, number[]> = {};
      for (const t of traces) {
        if (!ops[t.operation]) ops[t.operation] = [];
        ops[t.operation].push(t.duration_ms);
      }

      const snapshots = [];
      for (const [op, durations] of Object.entries(ops)) {
        durations.sort((a, b) => a - b);
        const count = durations.length;
        const sum = durations.reduce((a, b) => a + b, 0);
        
        snapshots.push({
          metric_name: 'trace_latency_ms',
          labels: { operation: op },
          window_start: windowStart,
          window_seconds: 60,
          value: sum / count, // mean
          count,
          min_val: durations[0],
          max_val: durations[count - 1],
          p50: durations[Math.floor(count * 0.5)],
          p95: durations[Math.floor(count * 0.95)],
          p99: durations[Math.floor(count * 0.99)],
        });
      }

      if (snapshots.length > 0) {
        await supabaseAdmin.from('metrics_snapshot').insert(snapshots);
      }
    }

    // 2. Aggregate cost events
    const { data: costs } = await supabaseAdmin
      .from('cost_events')
      .select('provider, model, cost_estimate, total_tokens')
      .gte('created_at', windowStart)
      .lt('created_at', windowEnd);

    if (costs && costs.length > 0) {
      const providers: Record<string, { cost: number, tokens: number, count: number }> = {};
      for (const c of costs) {
        const key = `${c.provider}::${c.model}`;
        if (!providers[key]) providers[key] = { cost: 0, tokens: 0, count: 0 };
        providers[key].cost += (c.cost_estimate || 0);
        providers[key].tokens += (c.total_tokens || 0);
        providers[key].count += 1;
      }

      const costSnapshots = [];
      for (const [key, agg] of Object.entries(providers)) {
        const [provider, model] = key.split('::');
        costSnapshots.push({
          metric_name: 'llm_cost_estimate',
          labels: { provider, model },
          window_start: windowStart,
          window_seconds: 60,
          value: agg.cost,
          count: agg.count
        });
        costSnapshots.push({
          metric_name: 'llm_tokens_total',
          labels: { provider, model },
          window_start: windowStart,
          window_seconds: 60,
          value: agg.tokens,
          count: agg.count
        });
      }

      if (costSnapshots.length > 0) {
        await supabaseAdmin.from('metrics_snapshot').insert(costSnapshots);
      }
    }

    await supabaseAdmin
      .from('aggregation_checkpoints')
      .update({ last_processed_at: windowEnd })
      .eq('id', 'metrics_aggregator');

    return new Response(JSON.stringify({ success: true, traces: traces?.length || 0, costs: costs?.length || 0 }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error("metrics-aggregator error:", err);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
