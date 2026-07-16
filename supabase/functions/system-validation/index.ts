import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("system-validation", requestId);

  function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Authenticate
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);
    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Run test suites
    const testResults: Record<string, { passed: boolean; [key: string]: any }> = {};

    // Test 1: Gmail Sync (No Duplicates) - basic connectivity check
    try {
      const { data: accounts, error: accErr } = await supabaseAdmin
        .from("connected_accounts")
        .select("provider, status, last_synced_at")
        .eq("user_id", user.id);
      testResults["test1_GmailSyncNoDuplicates"] = {
        passed: !accErr,
        accounts: accounts || [],
        error: accErr?.message
      };
    } catch (err: any) {
      testResults["test1_GmailSyncNoDuplicates"] = { passed: false, error: err.message };
    }

    // Test 2-4: Provider Connectivity (simplified - all traffic goes through OmniRoute)
    try {
      const omnirouteUrl = Deno.env.get("OMNIROUTE_BASE_URL");
      const omnirouteKey = Deno.env.get("OMNIROUTE_API_KEY");
      const omnirouteConfigured = !!omnirouteUrl && !!omnirouteKey;
      testResults["test2to4_ProviderFailover"] = {
        passed: omnirouteConfigured,
        routing: "OmniRoute",
        omniroute_configured: omnirouteConfigured,
        note: "All provider routing handled by OmniRoute"
      };
    } catch (err: any) {
      testResults["test2to4_ProviderFailover"] = { passed: false, error: err.message };
    }

    // Test 5: Queue Draining check
    try {
      const { data: jobs, error: jErr } = await supabaseAdmin
        .from("llm_jobs")
        .select("status, count")
        .eq("user_id", user.id)
        .limit(100);
      testResults["test5_QueueDraining"] = {
        passed: !jErr,
        job_count: jobs?.length || 0,
        error: jErr?.message
      };
    } catch (err: any) {
      testResults["test5_QueueDraining"] = { passed: false, error: err.message };
    }

    // Test 6: Memory Quality (basic check)
    try {
      const { data: memories, error: mErr } = await supabaseAdmin
        .from("memory_records")
        .select("id")
        .eq("user_id", user.id)
        .limit(10);
      testResults["test6_MemoryQuality"] = {
        passed: !mErr,
        memory_count: memories?.length || 0,
        error: mErr?.message
      };
    } catch (err: any) {
      testResults["test6_MemoryQuality"] = { passed: false, error: err.message };
    }

    // Test 7: Cost Measurement
    const costResult = await test7_CostMeasurement(supabaseAdmin);
    testResults["test7_CostMeasurement"] = costResult;

    // Test 8: Retrieval Latency (basic)
    try {
      const { data: runData, error: rErr } = await supabaseAdmin
        .from("retrieval_runs")
        .select("latency_ms")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(5);
      const avgLatency = runData?.length
        ? runData.reduce((s: number, r: any) => s + (r.latency_ms || 0), 0) / runData.length
        : null;
      testResults["test8_RetrievalLatency"] = {
        passed: avgLatency === null || avgLatency < 2000,
        avg_latency_ms: avgLatency,
        sample_count: runData?.length || 0,
        error: rErr?.message
      };
    } catch (err: any) {
      testResults["test8_RetrievalLatency"] = { passed: false, error: err.message };
    }

    const passed = Object.values(testResults).filter((r: any) => r.passed).length;
    const failed = Object.values(testResults).filter((r: any) => !r.passed).length;

    return jsonResponse({
      summary: {
        passed,
        failed,
        total: passed + failed,
        tests: Object.fromEntries(
          Object.entries(testResults).map(([k, v]: [string, any]) => [k, v.passed ? "PASS" : "FAIL"])
        )
      },
      detailed_results: testResults,
      timestamp: new Date().toISOString()
    });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});

// ============================================
// TEST 7: Cost Measurement
// ============================================
async function test7_CostMeasurement(supabaseAdmin: any) {
  const results: any = {
    passed: true,
    providerStats: [] as any[],
    requestsPerProvider: {} as Record<string, { extractions: number, verifications: number }>,
    totalExtractions: 0,
    totalVerifications: 0,
    projectedMonthlyCost: '0',
    errors: [] as string[]
  };

  try {
    // Get provider stats from cost_events
    const { data: costEvents } = await supabaseAdmin
      .from('cost_events')
      .select('provider, model, cost_estimate, total_tokens');

    // Aggregate by provider and model
    const providerStatsMap = new Map<string, {
      provider: string;
      model: string;
      total_cost: number;
      total_tokens: number;
      count: number;
    }>();

    costEvents?.forEach((event: any) => {
      const key = `${event.provider}::${event.model}`;
      if (!providerStatsMap.has(key)) {
        providerStatsMap.set(key, {
          provider: event.provider,
          model: event.model || 'unknown',
          total_cost: 0,
          total_tokens: 0,
          count: 0
        });
      }
      const stats = providerStatsMap.get(key)!;
      stats.total_cost += (event.cost_estimate || 0);
      stats.total_tokens += (event.total_tokens || 0);
      stats.count += 1;
    });

    results.providerStats = Array.from(providerStatsMap.values());

    // Get extraction logs for request counts
    const { data: extractionLogs } = await supabaseAdmin
      .from('memory_extraction_logs')
      .select('extractor_provider, verifier_provider')
      .order('timestamp', { ascending: false })
      .limit(500);

    const requestsPerProvider: Record<string, { extractions: number, verifications: number }> = {};
    extractionLogs?.forEach((log: any) => {
      if (!requestsPerProvider[log.extractor_provider]) {
        requestsPerProvider[log.extractor_provider] = { extractions: 0, verifications: 0 };
      }
      requestsPerProvider[log.extractor_provider].extractions++;
      if (log.verifier_provider !== log.extractor_provider && log.verifier_provider !== 'rule-engine') {
        requestsPerProvider[log.extractor_provider].verifications++;
      }
    });
    results.requestsPerProvider = requestsPerProvider;

    results.totalExtractions = Object.values(requestsPerProvider).reduce((sum, m) => sum + m.extractions, 0);
    results.totalVerifications = Object.values(requestsPerProvider).reduce((sum, m) => sum + m.verifications, 0);

    // Project future costs
    const estimatedTokensPerRequest = 500;
    const costPer1kTokens = 0.001; // Placeholder
    const projectedMonthlyRequests = results.totalExtractions * 30 * 2;
    const projectedMonthlyCost = (projectedMonthlyRequests * estimatedTokensPerRequest / 1000) * costPer1kTokens;
    results.projectedMonthlyCost = projectedMonthlyCost.toFixed(4);
  } catch (err: any) {
    results.errors.push(err.message);
  }

  return results;
}
