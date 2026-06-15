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

    const rl = await checkRateLimit(supabaseAdmin, user.id, "generate-briefing", RATE_LIMIT_PER_MIN);
    if (rl.limited) {
      return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
    }

    // Idempotency: don't queue if one is already pending/processing for this user.
    const { data: existingJobs } = await supabaseAdmin
      .from("llm_jobs")
      .select("id")
      .eq("user_id", user.id)
      .eq("job_type", "briefing_generation")
      .in("status", ["pending", "processing"])
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      return jsonResponse({ success: true, job_id: existingJobs[0].id, message: "Briefing generation already queued" });
    }

    // Plan quota: meter briefings per day (free plan is capped).
    const plan = await getUserPlan(supabaseAdmin, user.id);
    const quota = await consumeQuota(supabaseAdmin, user.id, "briefings", plan);
    if (!quota.allowed) {
      return jsonResponse({
        error: `Daily briefing limit reached (${quota.limit}/day on the ${plan} plan). Upgrade for unlimited briefings.`,
        code: "upgrade_required",
      }, 402);
    }

    const { data: job, error: insertError } = await supabaseAdmin
      .from("llm_jobs")
      .insert({
        user_id: user.id,
        job_type: "briefing_generation",
        priority: 1,
        status: "pending",
        payload: { request_id: requestId }
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
