import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { getUserPlan, planAllowsIntegration } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 10;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("slack-sync", requestId);

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

    const rl = await checkRateLimit(supabaseAdmin, user.id, "slack-sync", RATE_LIMIT_PER_MIN);
    if (rl.limited) return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);

    const plan = await getUserPlan(supabaseAdmin, user.id);
    if (!planAllowsIntegration(plan, "slack")) {
      return jsonResponse({ error: "Slack integration requires the Pro plan. Please upgrade.", code: "upgrade_required" }, 402);
    }

    const { data: secretData, error: secretErr } = await supabaseAdmin
      .from("integration_secrets")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider", "slack")
      .single();

    if (secretErr || !secretData?.access_token) {
      return jsonResponse({ error: "Slack connection not found." }, 404);
    }

    const accessToken = secretData.access_token;

    // Slack user tokens do not expire; a revoked/invalid token surfaces as
    // ok:false below, which we treat as a broken connection.
    const searchRes = await fetch(
      "https://slack.com/api/search.messages?query=" + encodeURIComponent("after:yesterday") + "&count=20&sort=timestamp",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    let searchData;
    try {
      searchData = await searchRes.json();
    } catch (_e) {
      return jsonResponse({ error: "Slack API error: unparseable response." }, 500);
    }

    if (!searchData.ok) {
      if (searchData.error === "token_revoked" || searchData.error === "invalid_auth") {
        await supabaseAdmin.from("connected_accounts")
          .update({ status: "broken" }).eq("user_id", user.id).eq("provider", "slack");
        return jsonResponse({ error: "Slack authorization is no longer valid. Reconnect required." }, 401);
      }
      return jsonResponse({ error: `Slack API error: ${searchData.error || "unknown"}` }, 500);
    }

    const matches = searchData.messages?.matches || [];
    let syncedCount = 0;

    for (const m of matches) {
      if (!m.ts) continue;
      let postedAt: string | null = null;
      const tsSeconds = parseFloat(m.ts);
      if (!Number.isNaN(tsSeconds)) postedAt = new Date(tsSeconds * 1000).toISOString();

      try {
        await supabaseAdmin.from("slack_messages").upsert({
          user_id: user.id,
          slack_ts: m.ts,
          channel_id: m.channel?.id ?? null,
          channel_name: m.channel?.name ?? null,
          author: m.username ?? m.user ?? null,
          text: m.text ?? "",
          permalink: m.permalink ?? null,
          posted_at: postedAt,
        }, { onConflict: "user_id,slack_ts" });
        syncedCount++;
      } catch (_err) {
        log.error("slack_message_upsert_failed");
      }
    }

    await supabaseAdmin.from("connected_accounts")
      .update({ last_synced_at: new Date().toISOString(), status: "active" })
      .eq("user_id", user.id)
      .eq("provider", "slack");

    return jsonResponse({ success: true, syncedCount });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
