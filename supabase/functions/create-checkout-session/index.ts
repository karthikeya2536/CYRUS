import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { isPayloadTooLarge } from "../_shared/payload.ts";
import { priceIdForPlan, type Plan } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const PAID_PLANS: Plan[] = ["pro", "business", "enterprise"];

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("create-checkout-session", requestId);

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
    const { plan, return_url } = body as { plan?: string; return_url?: string };

    if (!plan || !PAID_PLANS.includes(plan as Plan)) {
      return jsonResponse({ error: "Invalid plan" }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
    const appUrl = Deno.env.get("APP_URL") || return_url || "";

    if (!stripeSecret) {
      return jsonResponse({ error: "Billing is not configured. Set STRIPE_SECRET_KEY." }, 500);
    }

    const priceId = priceIdForPlan(plan as Plan);
    if (!priceId) {
      return jsonResponse({ error: `No Stripe price configured for the ${plan} plan.` }, 500);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Invalid user token" }, 401);

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Reuse an existing Stripe customer id if we already have one for this user.
    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("success_url", `${appUrl}/account?checkout=success`);
    form.set("cancel_url", `${appUrl}/account?checkout=cancel`);
    form.set("client_reference_id", user.id);
    // Carry the user id on the subscription so the webhook can map it back.
    form.set("subscription_data[metadata][user_id]", user.id);
    if (sub?.stripe_customer_id) {
      form.set("customer", sub.stripe_customer_id);
    } else {
      form.set("customer_email", user.email ?? "");
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok || !session.url) {
      log.error("stripe_session_create_failed");
      return jsonResponse({ error: "Failed to create checkout session." }, 502);
    }

    return jsonResponse({ url: session.url });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
