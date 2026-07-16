import { runWithTrace, flushSpans, setDefaultSupabaseClient } from "./supabase/functions/_shared/trace.ts";
import { LLMRouter, supabaseAdmin } from "./supabase/functions/_shared/llm-router.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

Deno.env.set('SUPABASE_URL', "http://127.0.0.1:54321");
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU");

Deno.env.set('OMNIROUTE_BASE_URL', "http://localhost:8000"); // Example
Deno.env.set('OMNIROUTE_API_KEY', "fake-omniroute");
Deno.env.set('OMNIROUTE_DEFAULT_MODEL', "omniroute-model");
Deno.env.set('OMNIROUTE_EMBEDDING_MODEL', "omniroute-embed");

// Mock fetch for external API calls — intercept any calls to the OmniRoute base URL
const originalFetch = globalThis.fetch;
const omniBaseUrl = Deno.env.get('OMNIROUTE_BASE_URL') ?? '';
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.startsWith(omniBaseUrl)) {
    const endpoint = url.slice(omniBaseUrl.length);
    // Mock embedings endpoint differently
    if (endpoint.includes('embeddings')) {
      return new Response(JSON.stringify({
        data: [{ embedding: new Array(768).fill(0.01) }],
        usage: { prompt_tokens: 10, total_tokens: 10 }
      }));
    }
    // Mock chat completions
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Mocked OmniRoute response" } }],
      usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 }
    }));
  }
  return originalFetch(input, init);
};

// Initialize LLMRouter
const router = new LLMRouter();
setDefaultSupabaseClient(supabaseAdmin);

// Function to simulate real execution
async function simulate() {
  console.log("OmniRoute is configured (mocked).");

  console.log("Running Gmail sync + Memory extraction...");
  await runWithTrace('gmail-sync', async () => {
    await runWithTrace('fetch_emails', async () => {});
    await runWithTrace('memory-extraction', async () => {
      // No need to force a provider - OmniRoute handles routing
      await LLMRouter.execute({
        userPrompt: "Extract memory",
        expectedFormat: 'json',
        capability: 'reasoning'
      });
    });
  });

  console.log("Running Calendar sync...");
  await runWithTrace('calendar-sync', async () => {
    await runWithTrace('fetch_events', async () => {});
    // No need to force a provider
    await LLMRouter.execute({
      userPrompt: "Parse events",
      capability: 'reasoning'
    });
  });

  console.log("Running Briefing generation...");
  await runWithTrace('briefing-generation', async () => {
    await runWithTrace('fetch_context', async () => {});
    // No need to force a provider
    await LLMRouter.execute({
      userPrompt: "Generate briefing",
      capability: 'summarization'
    });
  });

  console.log("Running Retrieve-context queries...");
  await runWithTrace('retrieve-context', async () => {
    await runWithTrace('hybrid-search', async () => {});
    await runWithTrace('graph-retrieval', async () => {});
    // No need to force a provider
    await LLMRouter.execute({
      userPrompt: "Rank results",
      capability: 'reasoning'
    });
  });

  console.log("Flushing spans...");
  await flushSpans();
  console.log("Waiting for unawaited cost inserts to finish...");
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function runMetricsAggregator() {
  console.log("Running metrics aggregator logic manually...");
  const supabaseAdmin = createClient("http://127.0.0.1:54321", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU");

  const windowStart = new Date(Date.now() - 120000).toISOString();
  const windowEnd = new Date().toISOString();

  const { data: traces } = await supabaseAdmin.from('traces').select('operation, duration_ms').gte('started_at', windowStart).lt('started_at', windowEnd).not('duration_ms', 'is', null);

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
      snapshots.push({ metric_name: 'trace_latency_ms', labels: { operation: op }, window_start: windowStart, window_seconds: 60, value: sum / count, count, min_val: durations[0], max_val: durations[count - 1], p50: durations[Math.floor(count * 0.5)], p95: durations[Math.floor(count * 0.95)], p99: durations[Math.floor(count * 0.99)] });
    }
    if (snapshots.length > 0) await supabaseAdmin.from('metrics_snapshot').insert(snapshots);
  }

  const { data: costs } = await supabaseAdmin.from('cost_events').select('provider, model, cost_estimate, total_tokens').gte('created_at', windowStart).lt('created_at', windowEnd);

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
      costSnapshots.push({ metric_name: 'llm_cost_estimate', labels: { provider, model }, window_start: windowStart, window_seconds: 60, value: agg.cost, count: agg.count });
      costSnapshots.push({ metric_name: 'llm_tokens_total', labels: { provider, model }, window_start: windowStart, window_seconds: 60, value: agg.tokens, count: agg.count });
    }
    if (costSnapshots.length > 0) await supabaseAdmin.from('metrics_snapshot').insert(costSnapshots);
  }
}

simulate().then(runMetricsAggregator).then(() => console.log("Simulate workload completed"));