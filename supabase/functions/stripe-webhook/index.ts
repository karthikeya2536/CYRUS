import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { planForPriceId } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

// Verify the Stripe-Signature header (scheme: t=<ts>,v1=<hmac>). Returns true
// only when an HMAC-SHA256 of `${t}.${body}` with the webhook secret matches.
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => kv.split("=").map((s) => s.trim())),
  ) as Record<string, string>;
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time compare.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

serve(async (req: Request) => {
  const requestId = newRequestId();
  const log = createLogger("stripe-webhook", requestId);

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!webhookSecret) {
    log.error("missing_webhook_secret");
    return new Response("Webhook not configured", { status: 500 });
  }

  const sigHeader = req.headers.get("Stripe-Signature");
  const rawBody = await req.text();

  if (!sigHeader || !(await verifyStripeSignature(rawBody, sigHeader, webhookSecret))) {
    log.warn("invalid_signature");
    return new Response("Invalid signature", { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");

  async function setPlanFromSubscription(subId: string, userIdHint?: string, customerId?: string) {
    if (!stripeSecret) return;
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      headers: { Authorization: `Bearer ${stripeSecret}` },
    });
    const sub = await subRes.json();
    if (!subRes.ok) {
      log.error("subscription_fetch_failed");
      return;
    }

    const userId = userIdHint || sub.metadata?.user_id;
    if (!userId) {
      log.error("no_user_id_on_subscription");
      return;
    }

    const priceId = sub.items?.data?.[0]?.price?.id;
    const plan = priceId ? planForPriceId(priceId) : null;
    const active = sub.status === "active" || sub.status === "trialing";
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;

    await supabaseAdmin.from("subscriptions").upsert({
      user_id: userId,
      plan: active && plan ? plan : "free",
      status: active ? "active" : (sub.status === "past_due" ? "past_due" : "canceled"),
      stripe_customer_id: customerId || sub.customer,
      stripe_subscription_id: sub.id,
      current_period_end: periodEnd,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.user_id;
        if (session.subscription) {
          await setPlanFromSubscription(session.subscription, userId, session.customer);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await setPlanFromSubscription(sub.id, sub.metadata?.user_id, sub.customer);
        break;
      }
      default:
        // Ignore unrelated events.
        break;
    }
  } catch (_err) {
    log.error("webhook_handler_error");
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
