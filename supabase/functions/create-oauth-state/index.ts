import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { isPayloadTooLarge } from "../_shared/payload.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { isSupportedProvider, isAllowedRedirectUri, sha256Hex } from "../_shared/validators.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

// Generate cryptographically secure random state
function generateSecureState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const STATE_EXPIRY_MINUTES = 10;
const RATE_LIMIT_PER_MIN = 20;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("create-oauth-state", requestId);

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
    const { provider, redirect_uri } = body as { provider?: string; redirect_uri?: string };

    if (!provider) {
      return jsonResponse({ error: "Missing provider" }, 400);
    }

    if (!isSupportedProvider(provider)) {
      return jsonResponse({ error: "Unsupported provider" }, 400);
    }

    // The callback redirect_uri is captured now and stored on the state row so
    // the exchange can bind the callback to the redirect_uri used at initiation.
    if (!redirect_uri) {
      return jsonResponse({ error: "Missing redirect_uri" }, 400);
    }
    const allowedRedirectUris = Deno.env.get("ALLOWED_REDIRECT_URIS");
    if (!isAllowedRedirectUri(redirect_uri, allowedRedirectUris)) {
      return jsonResponse({ error: "Invalid redirect_uri. Please contact the administrator." }, 400);
    }

    // Verify the user's JWT from the Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Create a client with the user's JWT to verify identity
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token" }, 401);
    }

    // Use service role client to write to oauth_states (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const rl = await checkRateLimit(supabaseAdmin, user.id, "create-oauth-state", RATE_LIMIT_PER_MIN);
    if (rl.limited) {
      return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
    }

    // Generate cryptographically secure state; store only its hash at rest.
    const state = generateSecureState();
    const stateHash = await sha256Hex(state);

    // Calculate expiry time
    const expiresAt = new Date(Date.now() + STATE_EXPIRY_MINUTES * 60 * 1000).toISOString();

    // Clean up any existing unused states for this user/provider
    const { error: cleanupError } = await supabaseAdmin
      .from("oauth_states")
      .delete()
      .eq("user_id", user.id)
      .eq("provider", provider)
      .is("used_at", null);

    if (cleanupError) {
      log.warn("oauth_state cleanup failed", {
        message: cleanupError.message,
        details: cleanupError.details,
        hint: cleanupError.hint,
        code: cleanupError.code,
      });
      // Continue anyway
    }

    // Store the new state
    log.error("DEPLOY_TEST_V2_STATE_HASH");
    const { error: insertError } = await supabaseAdmin
      .from("oauth_states")
      .insert({
        user_id: user.id,
        provider,
        state_hash: stateHash,
        redirect_uri,
        expires_at: expiresAt,
      });

    if (insertError) {
  log.error("oauth_state insert failed", {
    message: insertError.message,
    details: insertError.details,
    hint: insertError.hint,
    code: insertError.code,
  });

  return jsonResponse({ error: "Failed to create OAuth state" }, 500);
}

    return jsonResponse({ state, expires_at: expiresAt });

  } catch (_err: unknown) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
