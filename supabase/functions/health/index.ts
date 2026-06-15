import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

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

    // DB ping: a trivial count query.
    let dbOk = false;
    try {
      const { error } = await supabaseAdmin
        .from("provider_health")
        .select("provider_name", { count: "exact", head: true });
      dbOk = !error;
    } catch (_e) {
      dbOk = false;
    }

    // Provider health summary (sanitized: only non-sensitive status fields).
    const providers: Array<Record<string, unknown>> = [];
    try {
      const { data } = await supabaseAdmin
        .from("provider_health")
        .select("provider_name, failure_count, success_count, cooldown_until");
      for (const p of data || []) {
        const cooldownUntil = p.cooldown_until ? new Date(p.cooldown_until).getTime() : 0;
        providers.push({
          provider: p.provider_name,
          healthy: cooldownUntil <= Date.now(),
          failure_count: p.failure_count ?? 0,
          success_count: p.success_count ?? 0,
        });
      }
    } catch (_e) {
      // Leave providers empty on failure.
    }

    const status = dbOk ? "ok" : "degraded";
    return jsonResponse(
      { status, db: dbOk ? "ok" : "error", providers },
      dbOk ? 200 : 503,
    );

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
