import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 5;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("memory-extraction", requestId);

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

    const rl = await checkRateLimit(supabaseAdmin, user.id, "memory-extraction", RATE_LIMIT_PER_MIN);
    if (rl.limited) {
      return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
    }

    // Idempotency: don't queue if one is already pending/processing for this user.
    const { data: existingJobs } = await supabaseAdmin
      .from("llm_jobs")
      .select("id")
      .eq("user_id", user.id)
      .eq("job_type", "memory_extraction")
      .in("status", ["pending", "processing"])
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      return jsonResponse({ success: true, job_id: existingJobs[0].id, message: "Memory extraction already queued" });
    }

    const { data: job, error: insertError } = await supabaseAdmin
      .from("llm_jobs")
      .insert({
        user_id: user.id,
        job_type: "memory_extraction",
        priority: 2,
        status: "pending",
        payload: { request_id: requestId }
      })
      .select("id")
      .single();

    if (insertError) {
      return jsonResponse({ error: "Failed to queue memory extraction job" }, 500);
    }

    return jsonResponse({ success: true, job_id: job.id, message: "Memory extraction queued" });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
