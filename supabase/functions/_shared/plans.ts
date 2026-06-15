// Plan entitlements for Cyrus V2. Plan STATE is stored in public.subscriptions;
// per-plan LIMITS live here so they can be changed without a migration.
// A user with no subscription row is treated as "free".

export type Plan = "free" | "pro" | "business" | "enterprise";

export interface PlanLimits {
  // null = unlimited
  aiQueriesPerDay: number | null;
  briefingsPerDay: number | null;
  memoryRecordsMax: number | null;
  // providers the plan may connect / sync
  integrations: string[];
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    aiQueriesPerDay: 20,
    briefingsPerDay: 1,
    memoryRecordsMax: 500,
    integrations: ["google"],
  },
  pro: {
    aiQueriesPerDay: null,
    briefingsPerDay: null,
    memoryRecordsMax: 5000,
    integrations: ["google", "slack"],
  },
  business: {
    aiQueriesPerDay: null,
    briefingsPerDay: null,
    memoryRecordsMax: 50000,
    integrations: ["google", "slack", "notion", "linear"],
  },
  enterprise: {
    aiQueriesPerDay: null,
    briefingsPerDay: null,
    memoryRecordsMax: null,
    integrations: ["google", "slack", "notion", "linear", "outlook", "teams", "github", "jira"],
  },
};

function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pro" || value === "business" || value === "enterprise";
}

// Resolve a user's active plan. Defaults to "free" on missing row or a
// non-active subscription status (past_due / canceled lose entitlements).
export async function getUserPlan(supabaseAdmin: any, userId: string): Promise<Plan> {
  const { data } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data || data.status !== "active" || !isPlan(data.plan)) return "free";
  return data.plan;
}

export function planAllowsIntegration(plan: Plan, provider: string): boolean {
  return PLAN_LIMITS[plan].integrations.includes(provider);
}

// Check + atomically consume one unit of a daily-metered quota. Returns
// { allowed, limit, used }. limit === null means unlimited (no metering).
export async function consumeQuota(
  supabaseAdmin: any,
  userId: string,
  metric: "ai_queries" | "briefings",
  plan: Plan,
): Promise<{ allowed: boolean; limit: number | null; used: number }> {
  const limit = metric === "ai_queries"
    ? PLAN_LIMITS[plan].aiQueriesPerDay
    : PLAN_LIMITS[plan].briefingsPerDay;

  if (limit === null) return { allowed: true, limit: null, used: 0 };

  const { data, error } = await supabaseAdmin.rpc("increment_usage", {
    p_user_id: userId,
    p_metric: metric,
  });

  // Fail closed only on a hard limit breach; on RPC error, allow but report.
  if (error) return { allowed: true, limit, used: 0 };

  const used = typeof data === "number" ? data : 0;
  return { allowed: used <= limit, limit, used };
}

// Stripe price id -> plan, configured via env (STRIPE_PRICE_PRO, etc.).
export function planForPriceId(priceId: string): Plan | null {
  const map: Record<string, Plan> = {};
  const pro = Deno.env.get("STRIPE_PRICE_PRO");
  const business = Deno.env.get("STRIPE_PRICE_BUSINESS");
  const enterprise = Deno.env.get("STRIPE_PRICE_ENTERPRISE");
  if (pro) map[pro] = "pro";
  if (business) map[business] = "business";
  if (enterprise) map[enterprise] = "enterprise";
  return map[priceId] ?? null;
}

export function priceIdForPlan(plan: Plan): string | undefined {
  if (plan === "pro") return Deno.env.get("STRIPE_PRICE_PRO");
  if (plan === "business") return Deno.env.get("STRIPE_PRICE_BUSINESS");
  if (plan === "enterprise") return Deno.env.get("STRIPE_PRICE_ENTERPRISE");
  return undefined;
}
