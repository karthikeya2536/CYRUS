import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { getUserPlan, consumeQuota } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 5;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("generate-briefing", requestId);

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Resolve the target user. Two authenticated invocation paths (same pattern
    // as gmail-sync/calendar-sync):
    //   1. System (pg_cron -> pg_net): x-worker-secret matches WORKER_SECRET;
    //      user_id comes from the body. No rate limit. Tagged source="system".
    //   2. User request: JWT validated via getUser(), then rate-limited.
    // Duplicate protection, quota enforcement, and job insertion below run for
    // BOTH paths.
    let userId: string;
    let source: string;
    const workerSecret = req.headers.get("x-worker-secret");
    const expectedWorkerSecret = Deno.env.get("WORKER_SECRET");

    if (workerSecret && expectedWorkerSecret && workerSecret === expectedWorkerSecret) {
      source = "system";
      let body: { user_id?: string } = {};
      try {
        body = await req.json();
      } catch (_e) { /* empty/invalid body falls through to the check below */ }
      if (!body?.user_id) {
        return jsonResponse({ error: "Missing user_id for system invocation." }, 400);
      }
      userId = body.user_id;

      // System path only: do not generate daily briefings for users with no
      // active data source. Reuses connected_accounts.
      const { data: conn } = await supabaseAdmin
        .from("connected_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("provider", "google")
        .eq("status", "active")
        .limit(1);
      if (!conn || conn.length === 0) {
        return jsonResponse({ success: true, skipped: true, message: "No active Google connection" });
      }
    } else {
      source = "user";
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return jsonResponse({ error: "Missing authorization header" }, 401);
      }

      const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);
      if (userError || !user) {
        return jsonResponse({ error: "Invalid user token" }, 401);
      }

      const rl = await checkRateLimit(supabaseAdmin, user.id, "generate-briefing", RATE_LIMIT_PER_MIN);
      if (rl.limited) {
        return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
      }

      userId = user.id;
    }

    // Idempotency: don't queue if one is already pending/processing for this user.
    const { data: existingJobs } = await supabaseAdmin
      .from("llm_jobs")
      .select("id")
      .eq("user_id", userId)
      .eq("job_type", "briefing_generation")
      .in("status", ["pending", "processing"])
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      return jsonResponse({ success: true, job_id: existingJobs[0].id, message: "Briefing generation already queued" });
    }

    // Plan quota: meter briefings per day (free plan is capped).
    const plan = await getUserPlan(supabaseAdmin, userId);
    const quota = await consumeQuota(supabaseAdmin, userId, "briefings", plan);
    if (!quota.allowed) {
      return jsonResponse({
        error: `Daily briefing limit reached (${quota.limit}/day on the ${plan} plan). Upgrade for unlimited briefings.`,
        code: "upgrade_required",
      }, 402);
    }

    const { data: job, error: insertError } = await supabaseAdmin
      .from("llm_jobs")
      .insert({
        user_id: userId,
        job_type: "briefing_generation",
        priority: 1,
        status: "pending",
        payload: { request_id: requestId, source }
      })
      .select("id")
      .single();

    if (insertError) {
      return jsonResponse({ error: "Failed to queue briefing generation job" }, 500);
    }

    return jsonResponse({ success: true, job_id: job.id, message: "Briefing generation queued" });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
