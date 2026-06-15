-- ============================================
-- Migration: Phase 12 - Retrieval observability
-- ============================================
-- Additive telemetry only. Does not alter retrieval behavior. Tables are written
-- best-effort by the service role from retrieve-context; users may read their own
-- runs. Failures here must never affect a retrieval response.

-- ============================================
-- UP
-- ============================================

-- One row per retrieval invocation.
CREATE TABLE IF NOT EXISTS public.retrieval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  intent TEXT,
  embedding_available BOOLEAN,
  candidates_memories INTEGER DEFAULT 0,
  candidates_emails INTEGER DEFAULT 0,
  candidates_events INTEGER DEFAULT 0,
  included INTEGER DEFAULT 0,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.retrieval_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own retrieval_runs" ON public.retrieval_runs;
CREATE POLICY "Users can read own retrieval_runs" ON public.retrieval_runs FOR SELECT USING (auth.uid() = user_id);

-- One row per source channel per run: ranking telemetry.
CREATE TABLE IF NOT EXISTS public.retrieval_rank_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.retrieval_runs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,        -- 'memory' | 'email' | 'event'
  candidate_count INTEGER DEFAULT 0,
  ranked_count INTEGER DEFAULT 0,
  top_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.retrieval_rank_events ENABLE ROW LEVEL SECURITY;
-- Read via parent run ownership; service role writes.
DROP POLICY IF EXISTS "Users can read own rank_events" ON public.retrieval_rank_events;
CREATE POLICY "Users can read own rank_events" ON public.retrieval_rank_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.retrieval_runs r WHERE r.id = run_id AND r.user_id = auth.uid()));

-- One row per failed stage within a retrieval.
CREATE TABLE IF NOT EXISTS public.retrieval_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES public.retrieval_runs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,              -- 'embedding' | 'memory_search' | 'email_search' | 'event_search' | 'unhandled'
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.retrieval_failures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own retrieval_failures" ON public.retrieval_failures;
CREATE POLICY "Users can read own retrieval_failures" ON public.retrieval_failures FOR SELECT USING (auth.uid() = user_id);

-- --------------------------------------------
-- Indexes
-- --------------------------------------------
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_created ON public.retrieval_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_user_created ON public.retrieval_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_rank_events_run ON public.retrieval_rank_events (run_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_failures_created ON public.retrieval_failures (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_failures_stage ON public.retrieval_failures (stage, created_at DESC);

-- --------------------------------------------
-- Materialized views (daily rollups)
-- --------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS public.retrieval_daily_stats;
CREATE MATERIALIZED VIEW public.retrieval_daily_stats AS
SELECT
  date_trunc('day', created_at) AS day,
  count(*) AS runs,
  avg(latency_ms)::numeric(10,2) AS avg_latency_ms,
  avg(included)::numeric(10,2) AS avg_included,
  avg(CASE WHEN embedding_available THEN 1 ELSE 0 END)::numeric(5,4) AS embedding_available_rate
FROM public.retrieval_runs
GROUP BY 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_daily_stats_day ON public.retrieval_daily_stats (day);

DROP MATERIALIZED VIEW IF EXISTS public.retrieval_failure_stats;
CREATE MATERIALIZED VIEW public.retrieval_failure_stats AS
SELECT
  date_trunc('day', created_at) AS day,
  stage,
  count(*) AS failures
FROM public.retrieval_failures
GROUP BY 1, 2;
CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_failure_stats_day_stage ON public.retrieval_failure_stats (day, stage);

-- --------------------------------------------
-- Retention + refresh job logic
-- --------------------------------------------
-- Deletes telemetry older than retain_days (rank_events cascade via FK) and
-- refreshes the rollups. Safe to call repeatedly.
CREATE OR REPLACE FUNCTION public.purge_retrieval_telemetry(retain_days INTEGER DEFAULT 30)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  DELETE FROM public.retrieval_runs     WHERE created_at < NOW() - make_interval(days => retain_days);
  DELETE FROM public.retrieval_failures WHERE created_at < NOW() - make_interval(days => retain_days);
  REFRESH MATERIALIZED VIEW public.retrieval_daily_stats;
  REFRESH MATERIALIZED VIEW public.retrieval_failure_stats;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_retrieval_telemetry(INTEGER) FROM PUBLIC, anon, authenticated;

-- Schedule a daily retention job if pg_cron is available. Guarded so the
-- migration does not fail on environments without pg_cron (e.g. local dev).
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF FOUND THEN
    PERFORM cron.schedule('purge-retrieval-telemetry', '17 3 * * *', $cron$SELECT public.purge_retrieval_telemetry(30);$cron$);
  ELSE
    RAISE NOTICE 'pg_cron not installed; run SELECT public.purge_retrieval_telemetry(30) via an external scheduler.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule retention job: %', SQLERRM;
END $$;

-- ============================================
-- ROLLBACK
-- ============================================
-- SELECT cron.unschedule('purge-retrieval-telemetry');  -- if scheduled
-- DROP FUNCTION IF EXISTS public.purge_retrieval_telemetry(INTEGER);
-- DROP MATERIALIZED VIEW IF EXISTS public.retrieval_failure_stats;
-- DROP MATERIALIZED VIEW IF EXISTS public.retrieval_daily_stats;
-- DROP TABLE IF EXISTS public.retrieval_rank_events;
-- DROP TABLE IF EXISTS public.retrieval_failures;
-- DROP TABLE IF EXISTS public.retrieval_runs;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT matviewname FROM pg_matviews WHERE schemaname='public';
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename LIKE 'retrieval_%';
