-- Migration: Edge function rate limiting
-- Fixed-window counter table keyed by (user_id, fn, window_start).
-- Service-role only: RLS enabled with NO user policies, so authenticated/anon
-- callers cannot read or tamper with counters; the service role bypasses RLS.

CREATE TABLE IF NOT EXISTS public.rate_limits (
  user_id UUID NOT NULL,
  fn TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, fn, window_start)
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
-- No RLS policies: only the service role (edge functions) touches this table.

GRANT ALL ON public.rate_limits TO service_role;

-- Index for cleanup of expired windows.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON public.rate_limits (window_start);

-- Atomic increment: insert the window row or bump its count, returning the new
-- count. SECURITY DEFINER so it runs with the table owner's rights; callable by
-- the service role only.
CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_user_id UUID,
  p_fn TEXT,
  p_window_start TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO public.rate_limits (user_id, fn, window_start, count)
  VALUES (p_user_id, p_fn, p_window_start, 1)
  ON CONFLICT (user_id, fn, window_start)
  DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO new_count;

  RETURN new_count;
END;
$$;

-- Supabase auto-grants EXECUTE to anon/authenticated via ALTER DEFAULT
-- PRIVILEGES, so revoke them explicitly in addition to PUBLIC. Service-role
-- only counter; anon/authenticated must not call it.
REVOKE ALL ON FUNCTION public.increment_rate_limit(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit(UUID, TEXT, TIMESTAMPTZ) TO service_role;

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP FUNCTION IF EXISTS public.increment_rate_limit(UUID, TEXT, TIMESTAMPTZ);
-- DROP INDEX IF EXISTS public.idx_rate_limits_window_start;
-- DROP TABLE IF EXISTS public.rate_limits;
