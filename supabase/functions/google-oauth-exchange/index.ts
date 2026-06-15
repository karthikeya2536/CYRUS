import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { isPayloadTooLarge } from "../_shared/payload.ts";
import { isAllowedRedirectUri } from "../_shared/validators.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("google-oauth-exchange", requestId);

  function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Handle CORS preflight
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

    if (!code) {
      return jsonResponse({ error: "Missing authorization code" }, 400);
    }
    if (!redirect_uri) {
      return jsonResponse({ error: "Missing redirect_uri" }, 400);
    }
    if (!state) {
      return jsonResponse({ error: "Missing OAuth state" }, 400);
    }

    // Validate redirect_uri against allowlist (strict parse, localhost allowed)
    const allowedRedirectUris = Deno.env.get("ALLOWED_REDIRECT_URIS");
    if (!isAllowedRedirectUri(redirect_uri, allowedRedirectUris)) {
      return jsonResponse({
        error: "Invalid redirect_uri. Please contact the administrator.",
      }, 400);
    }

    // Verify the user's JWT from the Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

    if (!googleClientId || !googleClientSecret) {
      return jsonResponse({ error: "Server misconfiguration: missing Google OAuth credentials. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as edge function secrets." }, 500);
    }

    // Create a client with the user's JWT to verify identity
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token" }, 401);
    }

    // Validate OAuth state server-side
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Look up the state
    const { data: stateRecord, error: stateError } = await supabaseAdmin
      .from("oauth_states")
      .select("id, expires_at, used_at")
      .eq("user_id", user.id)
      .eq("provider", "google")
      .eq("state", state)
      .is("used_at", null)
      .maybeSingle();

    if (stateError) {
      return jsonResponse({ error: "Failed to validate OAuth state" }, 500);
    }

    if (!stateRecord) {
      return jsonResponse({ error: "Invalid or expired OAuth state. Please try connecting Google again." }, 400);
    }

    // Check if state has expired
    const now = new Date();
    const expiresAt = new Date(stateRecord.expires_at);
    if (now > expiresAt) {
      return jsonResponse({ error: "OAuth state has expired. Please try connecting Google again." }, 400);
    }

    // Mark state as used to prevent replay attacks
    const { error: markUsedError } = await supabaseAdmin
      .from("oauth_states")
      .update({ used_at: now.toISOString() })
      .eq("id", stateRecord.id);

    if (markUsedError) {
      log.error("oauth_state_mark_used_failed");
      return jsonResponse({ error: "Failed to validate OAuth state" }, 500);
    }

    // Exchange authorization code for tokens with Google
    // redirect_uri comes from the frontend so it exactly matches the one used in the auth request
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      return jsonResponse({
        error: `Google token error: ${tokenData.error_description || tokenData.error}`,
      }, 400);
    }

    // Fetch user info from Google to get the connected email
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userInfoResponse.json();

    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    // Upsert connected_accounts
    const { error: accountError } = await supabaseAdmin
      .from("connected_accounts")
      .upsert(
        {
          user_id: user.id,
          provider: "google",
          provider_email: googleUser.email,
          connected_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

    if (accountError) {
      log.error("connected_account_save_failed");
      return jsonResponse({ error: "Failed to save connected account" }, 500);
    }

    // Preserve existing refresh_token if Google doesn't return one
    const { data: existingSecrets, error: existingError } = await supabaseAdmin
      .from("integration_secrets")
      .select("refresh_token")
      .eq("user_id", user.id)
      .eq("provider", "google")
      .maybeSingle();

    if (existingError) {
      log.error("existing_tokens_read_failed");
      return jsonResponse({ error: "Failed to read existing tokens" }, 500);
    }

    const existingRefreshToken = existingSecrets?.refresh_token ?? null;
    const refreshTokenToStore = tokenData.refresh_token ?? existingRefreshToken;

    // Upsert integration_secrets
    const { error: secretError } = await supabaseAdmin
      .from("integration_secrets")
      .upsert(
        {
          user_id: user.id,
          provider: "google",
          access_token: tokenData.access_token,
          refresh_token: refreshTokenToStore,
          token_expires_at: tokenExpiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

    if (secretError) {
      log.error("token_save_failed");
      return jsonResponse({ error: "Failed to save tokens" }, 500);
    }

    return jsonResponse({ success: true, provider_email: googleUser.email });

  } catch (_err: unknown) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
