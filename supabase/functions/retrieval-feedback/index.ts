import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { isPayloadTooLarge } from "../_shared/payload.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const MAX_FEEDBACK_LEN = 2000;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("retrieval-feedback", requestId);

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
    if (isPayloadTooLarge(req)) return jsonResponse({ error: "Payload too large" }, 413);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { run_id, rating, feedback, retrieval_version, candidate_limit, embedding_model } = body as {
      run_id?: string;
      rating?: string;
      feedback?: string;
      retrieval_version?: string;
      candidate_limit?: number;
      embedding_model?: string;
    };

    if (rating !== "up" && rating !== "down") {
      return jsonResponse({ error: "rating must be 'up' or 'down'" }, 400);
    }
    if (feedback !== undefined && (typeof feedback !== "string" || feedback.length > MAX_FEEDBACK_LEN)) {
      return jsonResponse({ error: `feedback must be a string up to ${MAX_FEEDBACK_LEN} chars` }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Invalid user token" }, 401);

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { error: insertError } = await supabaseAdmin.from("retrieval_evaluations").insert({
      user_id: user.id,                                  // identity from JWT only
      run_id: typeof run_id === "string" ? run_id : null,
      rating,
      feedback: typeof feedback === "string" ? feedback : null,
      retrieval_version: typeof retrieval_version === "string" ? retrieval_version : null,
      candidate_limit: typeof candidate_limit === "number" ? candidate_limit : null,
      embedding_model: typeof embedding_model === "string" ? embedding_model : null,
    });

    if (insertError) {
      log.error("feedback_insert_failed");
      return jsonResponse({ error: "Failed to store feedback" }, 500);
    }

    return jsonResponse({ success: true });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
