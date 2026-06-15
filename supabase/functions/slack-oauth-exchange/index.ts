import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { isPayloadTooLarge } from "../_shared/payload.ts";
import { isAllowedRedirectUri } from "../_shared/validators.ts";
import { getUserPlan, planAllowsIntegration } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("slack-oauth-exchange", requestId);

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
    if (isPayloadTooLarge(req)) {
      return jsonResponse({ error: "Payload too large" }, 413);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const { code, redirect_uri, state } = body as { code?: string; redirect_uri?: string; state?: string };

    if (!code) return jsonResponse({ error: "Missing authorization code" }, 400);
    if (!redirect_uri) return jsonResponse({ error: "Missing redirect_uri" }, 400);
    if (!state) return jsonResponse({ error: "Missing OAuth state" }, 400);

    const allowedRedirectUris = Deno.env.get("ALLOWED_REDIRECT_URIS");
    if (!isAllowedRedirectUri(redirect_uri, allowedRedirectUris)) {
      return jsonResponse({ error: "Invalid redirect_uri. Please contact the administrator." }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const slackClientId = Deno.env.get("SLACK_CLIENT_ID");
    const slackClientSecret = Deno.env.get("SLACK_CLIENT_SECRET");

    if (!slackClientId || !slackClientSecret) {
      return jsonResponse({ error: "Server misconfiguration: missing Slack OAuth credentials. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET as edge function secrets." }, 500);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Invalid user token" }, 401);

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Plan gate: Slack requires Pro or higher.
    const plan = await getUserPlan(supabaseAdmin, user.id);
    if (!planAllowsIntegration(plan, "slack")) {
      return jsonResponse({ error: "Slack integration requires the Pro plan. Please upgrade.", code: "upgrade_required" }, 402);
    }

    // Validate OAuth state server-side (single-use, unexpired)
    const { data: stateRecord, error: stateError } = await supabaseAdmin
      .from("oauth_states")
      .select("id, expires_at, used_at")
      .eq("user_id", user.id)
      .eq("provider", "slack")
      .eq("state", state)
      .is("used_at", null)
      .maybeSingle();

    if (stateError) return jsonResponse({ error: "Failed to validate OAuth state" }, 500);
    if (!stateRecord) return jsonResponse({ error: "Invalid or expired OAuth state. Please try connecting Slack again." }, 400);

    const now = new Date();
    if (now > new Date(stateRecord.expires_at)) {
      return jsonResponse({ error: "OAuth state has expired. Please try connecting Slack again." }, 400);
    }

    const { error: markUsedError } = await supabaseAdmin
      .from("oauth_states")
      .update({ used_at: now.toISOString() })
      .eq("id", stateRecord.id);

    if (markUsedError) {
      log.error("oauth_state_mark_used_failed");
      return jsonResponse({ error: "Failed to validate OAuth state" }, 500);
    }

    // Exchange code for tokens (Slack OAuth v2)
    const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: slackClientId,
        client_secret: slackClientSecret,
        redirect_uri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      return jsonResponse({ error: `Slack token error: ${tokenData.error || "unknown"}` }, 400);
    }

    // Slack v2: user token under authed_user, bot token at top level. Persist
    // whichever access token is present; prefer the user token for reading.
    const accessToken = tokenData.authed_user?.access_token ?? tokenData.access_token;
    const teamName = tokenData.team?.name ?? null;

    if (!accessToken) {
      return jsonResponse({ error: "Slack did not return an access token." }, 400);
    }

    const { error: accountError } = await supabaseAdmin
      .from("connected_accounts")
      .upsert(
        {
          user_id: user.id,
          provider: "slack",
          provider_email: teamName,
          connected_at: new Date().toISOString(),
          status: "active",
        },
        { onConflict: "user_id,provider" }
      );

    if (accountError) {
      log.error("connected_account_save_failed");
      return jsonResponse({ error: "Failed to save connected account" }, 500);
    }

    const { error: secretError } = await supabaseAdmin
      .from("integration_secrets")
      .upsert(
        {
          user_id: user.id,
          provider: "slack",
          access_token: accessToken,
          token_expires_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

    if (secretError) {
      log.error("token_save_failed");
      return jsonResponse({ error: "Failed to save tokens" }, 500);
    }

    return jsonResponse({ success: true, team: teamName });

  } catch (_err: unknown) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
