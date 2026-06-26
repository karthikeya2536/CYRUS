import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const supabaseUrl = Deno.env.get('SUPABASE_URL') || "http://127.0.0.1:54321";
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const supabase = createClient(supabaseUrl, supabaseKey);

async function runQueries() {
  console.log("--- count(*) queries ---");
  const { count: tracesCount } = await supabase.from('traces').select('*', { count: 'exact', head: true });
  console.log("traces:", tracesCount);

  const { count: costEventsCount } = await supabase.from('cost_events').select('*', { count: 'exact', head: true });
  console.log("cost_events:", costEventsCount);

  const { count: metricsSnapshotCount } = await supabase.from('metrics_snapshot').select('*', { count: 'exact', head: true });
  console.log("metrics_snapshot:", metricsSnapshotCount);

  console.log("\n--- SELECT operation, count(*) FROM traces GROUP BY operation ORDER BY count DESC ---");
  const { data: operations } = await supabase.rpc('get_traces_operations_count')
    .then((res: any) => {
      // If RPC fails (not defined), let's just fetch all and group locally to avoid raw SQL setup
      return supabase.from('traces').select('operation');
    });
  
  if (operations) {
    const counts: Record<string, number> = {};
    for (const t of operations) {
      counts[t.operation] = (counts[t.operation] || 0) + 1;
    }
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([op, count]) => {
      console.log(`operation: ${op.padEnd(25)} count: ${count}`);
    });
  }

  console.log("\n--- SELECT c.trace_id, p.operation parent_operation, c.operation child_operation FROM traces c JOIN traces p ON c.parent_span_id = p.span_id LIMIT 50 ---");
  // Fetch locally since JS client lacks joins natively
  const { data: traces } = await supabase.from('traces').select('trace_id, span_id, parent_span_id, operation');
  if (traces) {
    const traceMap = new Map();
    for (const t of traces) {
      traceMap.set(t.span_id, t);
    }
    let found = 0;
    for (const c of traces) {
      if (c.parent_span_id && traceMap.has(c.parent_span_id)) {
        const p = traceMap.get(c.parent_span_id);
        console.log(`trace_id: ${c.trace_id.substring(0,8)}... | parent: ${p.operation.padEnd(20)} | child: ${c.operation}`);
        found++;
        if (found >= 50) break;
      }
    }
  }

  console.log("\n--- Measure Cost Visibility ---");
  const { data: costEvents } = await supabase.from('cost_events').select('provider, model, total_tokens, cost_estimate');
  if (costEvents) {
    const agg: Record<string, { tokens: number, cost: number }> = {};
    for (const c of costEvents) {
      const key = `${c.provider}::${c.model}`;
      if (!agg[key]) agg[key] = { tokens: 0, cost: 0 };
      agg[key].tokens += (c.total_tokens || 0);
      agg[key].cost += (c.cost_estimate || 0);
    }
    console.log("provider".padEnd(15) + "model".padEnd(25) + "total_tokens".padEnd(15) + "cost_estimate");
    for (const [key, val] of Object.entries(agg)) {
      const [provider, model] = key.split("::");
      console.log(`${provider.padEnd(15)}${model.padEnd(25)}${val.tokens.toString().padEnd(15)}${val.cost.toFixed(6)}`);
    }
  }

  console.log("\n--- Cost Event Errors ---");
  const { data: errors   console.log("\n--- Trace Completeness ---");
  const { data: traces } = await supabase.from('traces').select('trace_id');
  const traceCounts: Record<string, number> = {};
  if (traces) {
    for (const t of traces) {
      traceCounts[t.trace_id] = (traceCounts[t.trace_id] || 0) + 1;
    }
    const sorted = Object.entries(traceCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [tId, count] of sorted) {
      console.log(`trace_id: ${tId} | spans: ${count}`);
    }
  }

} = await supabase.from('cost_events').select('*').eq('status', 'error').limit(5);
  console.log(errors);

}

runQueries().catch(console.error);
