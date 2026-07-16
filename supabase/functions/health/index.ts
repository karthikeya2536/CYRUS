import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

// ── Thresholds (the "actionable" part — change these as ops requirements evolve)
const THRESHOLDS = {
  queueDepth:      { warn: 100, label: "llm_queue_depth" },
  deadLetterRate:  { warn: 10,  label: "llm_dead_letter_rate" }, // per hour
  graphLatencyP95: { warn: 500, label: "graph_latency_p95" },    // ms
  omnirouteLatP95: { warn: 2000, label: "omniroute_latency_p95" }, // ms
  embeddingFailPct: { warn: 1.0, label: "retrieval_embedding_failure_rate" }, // percent
};

interface CheckResult {
  check: string;
  status: "ok" | "warn" | "error";
  value: string | number;
  threshold: number;
  hint: string;
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("health", requestId);

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

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const checks: CheckResult[] = [];

    // ── 1. DB ping ────────────────────────────────────────────────────────
    let dbOk = false;
    try {
      const { error } = await supabaseAdmin
        .from("migrations")
        .select("version", { count: "exact", head: true });
      dbOk = !error;
    } catch (_e) {
      dbOk = false;
    }
    checks.push({
      check: "database",
      status: dbOk ? "ok" : "error",
      value: dbOk ? "reachable" : "unreachable",
      threshold: 0,
      hint: dbOk ? "" : "Check Supabase project status. If local, verify `supabase start` / postgres port 54322.",
    });

    // ── 2. OmniRoute config ───────────────────────────────────────────────
    const omnirouteUrl = Deno.env.get("OMNIROUTE_BASE_URL");
    const omnirouteKey = Deno.env.get("OMNIROUTE_API_KEY");
    const omnirouteConfigured = !!omnirouteUrl && !!omnirouteKey && omnirouteUrl.length > 0 && omnirouteKey.length > 0;
    checks.push({
      check: "omniroute_configured",
      status: omnirouteConfigured ? "ok" : "error",
      value: omnirouteConfigured ? "configured" : "not configured",
      threshold: 0,
      hint: omnirouteConfigured ? "" : "Set OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY secrets. Run: supabase secrets set OMNIROUTE_BASE_URL=... OMNIROUTE_API_KEY=...",
    });

    // ── 3. Queue depth ────────────────────────────────────────────────────
    const { count: pendingJobs } = await supabaseAdmin
      .from("llm_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");

    const queueDepth = pendingJobs ?? 0;
    checks.push({
      check: THRESHOLDS.queueDepth.label,
      status: queueDepth >= THRESHOLDS.queueDepth.warn ? "warn" : "ok",
      value: queueDepth,
      threshold: THRESHOLDS.queueDepth.warn,
      hint: queueDepth >= THRESHOLDS.queueDepth.warn
        ? `Queue depth ${queueDepth} exceeds ${THRESHOLDS.queueDepth.warn}. Check llm-worker logs and pg_cron. If sustained, increase worker concurrency or investigate stuck jobs.`
        : "",
    });

    // ── 4. Dead-letter rate (last hour) ───────────────────────────────────
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: deadLettersHour } = await supabaseAdmin
      .from("llm_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", "permanently_failed")
      .gte("created_at", oneHourAgo);

    const deadCount = deadLettersHour ?? 0;
    checks.push({
      check: THRESHOLDS.deadLetterRate.label,
      status: deadCount >= THRESHOLDS.deadLetterRate.warn ? "warn" : "ok",
      value: `${deadCount}/hour`,
      threshold: THRESHOLDS.deadLetterRate.warn,
      hint: deadCount >= THRESHOLDS.deadLetterRate.warn
        ? `${deadCount} permanently_failed jobs this hour. Query: SELECT job_type, last_error FROM llm_jobs WHERE status='permanently_failed' AND created_at > now() - interval '1 hour'. Check provider status and fix the underlying error.`
        : "",
    });

    // ── 5. Graph latency p95 (from latest metrics_snapshot) ───────────────
    const { data: graphLatRow } = await supabaseAdmin
      .from("metrics_snapshot")
      .select("p95, window_start")
      .eq("metric_name", "graph_latency_p95")
      .order("window_start", { ascending: false })
      .limit(1);

    const graphP95 = (graphLatRow && graphLatRow.length > 0) ? graphLatRow[0].p95 : 0;
    checks.push({
      check: THRESHOLDS.graphLatencyP95.label,
      status: graphP95 >= THRESHOLDS.graphLatencyP95.warn ? "warn" : "ok",
      value: `${graphP95} ms`,
      threshold: THRESHOLDS.graphLatencyP95.warn,
      hint: graphP95 >= THRESHOLDS.graphLatencyP95.warn
        ? `Graph render p95 ${graphP95}ms exceeds ${THRESHOLDS.graphLatencyP95.warn}ms. Check graph_render_relations RPC: EXPLAIN ANALYZE with realistic params. Consider index on knowledge_graph_edges(source, relationship, target, confidence).`
        : "",
    });

    // ── 6. OmniRoute latency p95 ──────────────────────────────────────────
    const { data: omniLatRow } = await supabaseAdmin
      .from("metrics_snapshot")
      .select("p95, window_start, labels")
      .eq("metric_name", "omniroute_latency_p95")
      .order("window_start", { ascending: false })
      .limit(1);

    const omniP95 = (omniLatRow && omniLatRow.length > 0) ? omniLatRow[0].p95 : 0;
    checks.push({
      check: THRESHOLDS.omnirouteLatP95.label,
      status: omniP95 >= THRESHOLDS.omnirouteLatP95.warn ? "warn" : "ok",
      value: `${omniP95} ms`,
      threshold: THRESHOLDS.omnirouteLatP95.warn,
      hint: omniP95 >= THRESHOLDS.omnirouteLatP95.warn
        ? `OmniRoute p95 ${omniP95}ms exceeds ${THRESHOLDS.omnirouteLatP95.warn}ms. Check OmniRoute dashboard for provider degradations. Consider LLMRouter fallback to secondary provider.`
        : "",
    });

    // ── 7. Embedding failure rate ─────────────────────────────────────────
    const { data: embedFailRow } = await supabaseAdmin
      .from("metrics_snapshot")
      .select("value, window_start")
      .eq("metric_name", "retrieval_embedding_failure_rate")
      .order("window_start", { ascending: false })
      .limit(1);

    const embedFailPct = (embedFailRow && embedFailRow.length > 0) ? (embedFailRow[0].value as number) * 100 : 0;
    checks.push({
      check: THRESHOLDS.embeddingFailPct.label,
      status: embedFailPct >= THRESHOLDS.embeddingFailPct.warn ? "warn" : "ok",
      value: `${embedFailPct.toFixed(2)}%`,
      threshold: THRESHOLDS.embeddingFailPct.warn,
      hint: embedFailPct >= THRESHOLDS.embeddingFailPct.warn
        ? `Embedding failure rate ${embedFailPct.toFixed(2)}% exceeds ${THRESHOLDS.embeddingFailPct.warn}%. Check OmniRoute embedding endpoint. Query: SELECT message FROM retrieval_failures WHERE stage='embedding' AND created_at > now() - interval '5 minutes'.`
        : "",
    });

    // ── Aggregate status ──────────────────────────────────────────────────
    const hasError = checks.some(c => c.status === "error");
    const hasWarn = checks.some(c => c.status === "warn");
    const overallStatus = hasError ? "error" : hasWarn ? "degraded" : "ok";

    return jsonResponse({
      status: overallStatus,
      checks,
      summary: {
        ok: checks.filter(c => c.status === "ok").length,
        warn: checks.filter(c => c.status === "warn").length,
        error: checks.filter(c => c.status === "error").length,
      },
    }, overallStatus === "ok" ? 200 : 503);

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
