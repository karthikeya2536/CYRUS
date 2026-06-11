import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { code, redirect_uri } = await req.json();

    if (!code) {
      return jsonResponse({ error: "Missing authorization code" }, 400);
    }
    if (!redirect_uri) {
      return jsonResponse({ error: "Missing redirect_uri" }, 400);
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

    // Use service role client to write to integration_secrets (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

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
      return jsonResponse({
        error: `Failed to save connected account: ${accountError.message}`,
      }, 500);
    }

    // Preserve existing refresh_token if Google doesn't return one
    const { data: existingSecrets, error: existingError } = await supabaseAdmin
      .from("integration_secrets")
      .select("refresh_token")
      .eq("user_id", user.id)
      .eq("provider", "google")
      .maybeSingle();

    if (existingError) {
      return jsonResponse({
        error: `Failed to read existing tokens: ${existingError.message}`,
      }, 500);
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
      return jsonResponse({
        error: `Failed to save tokens: ${secretError.message}`,
      }, 500);
    }

    return jsonResponse({ success: true, provider_email: googleUser.email });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `Internal error: ${msg}` }, 500);
  }
});
