-- ============================================
-- Migration: Subscriptions & usage metering
-- ============================================
-- Plan state lives here; per-plan limits live in code (_shared/plans.ts).
-- A user with no row is treated as the free plan (lazy default), so existing
-- users need no backfill. Rows are written only by the service role (Stripe
-- webhook); users may read their own row.

-- ============================================
-- UP
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',          -- free | pro | business | enterprise
  status TEXT NOT NULL DEFAULT 'active',      -- active | past_due | canceled
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT subscriptions_plan_chk CHECK (plan IN ('free','pro','business','enterprise'))
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own subscription" ON public.subscriptions;
-- Read-only for users; all writes go through the service role (webhook).
CREATE POLICY "Users can read own subscription" ON public.subscriptions FOR SELECT USING (auth.uid() = user_id);

-- --------------------------------------------
-- usage_counters: per-user per-metric per-day counters for plan quotas
-- (ai_queries, briefings). Written by the service role in edge functions;
-- users may read their own usage for the billing screen.
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_counters (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, metric, day)
);

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own usage" ON public.usage_counters;
CREATE POLICY "Users can read own usage" ON public.usage_counters FOR SELECT USING (auth.uid() = user_id);

-- Atomic increment + read used by the quota helper (service role).
CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id UUID, p_metric TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO public.usage_counters (user_id, metric, day, count)
  VALUES (p_user_id, p_metric, CURRENT_DATE, 1)
  ON CONFLICT (user_id, metric, day)
  DO UPDATE SET count = public.usage_counters.count + 1
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$;

-- Revoke PUBLIC as well as anon/authenticated: anon is a member of PUBLIC and
-- would otherwise retain the default EXECUTE grant on this SECURITY DEFINER fn.
REVOKE EXECUTE ON FUNCTION public.increment_usage(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP FUNCTION IF EXISTS public.increment_usage(UUID, TEXT);
-- DROP TABLE IF EXISTS public.usage_counters;
-- DROP TABLE IF EXISTS public.subscriptions;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename IN ('subscriptions','usage_counters');  -- expect true
