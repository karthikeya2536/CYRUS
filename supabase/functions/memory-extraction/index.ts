import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
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

    const { data: job, error: insertError } = await supabaseAdmin
      .from("llm_jobs")
      .insert({
        user_id: user.id,
        job_type: "memory_extraction",
        priority: 2,
        status: "pending"
      })
      .select("id")
      .single();

    if (insertError) {
      return jsonResponse({ error: "Failed to queue memory extraction job" }, 500);
    }

    return jsonResponse({ success: true, job_id: job.id, message: "Memory extraction queued" });

  } catch (err: any) {
    console.error("Memory Extraction Queueing Error:", err);
    return jsonResponse({ error: `Internal error: ${err.message}` }, 500);
  }
});
