-- ============================================
-- Migration: 038_observability_platform.sql
-- ============================================
-- Core observability infrastructure: traces, cost_events, metrics_snapshot.

-- 1. traces
CREATE TABLE IF NOT EXISTS public.traces (
  span_id UUID PRIMARY KEY,
  trace_id UUID NOT NULL,
  parent_span_id UUID,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  span_kind TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER,
  status TEXT DEFAULT 'unset',
  status_message TEXT,
  attributes JSONB DEFAULT '{}'::jsonb,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  job_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.traces DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.traces;
REVOKE ALL ON public.traces FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.traces TO service_role;

CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON public.traces (trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_started_at ON public.traces (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_created_at ON public.traces (created_at DESC);

-- 2. cost_events
CREATE TABLE IF NOT EXISTS public.cost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID,
  span_id UUID,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  job_id UUID,
  provider TEXT NOT NULL,
  model TEXT,
  operation TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_estimate DOUBLE PRECISION DEFAULT 0,
  latency_ms INTEGER,
  status TEXT DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  attributes JSONB DEFAULT '{}'::jsonb
);

ALTER TABLE public.cost_events DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.cost_events;
REVOKE ALL ON public.cost_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cost_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_cost_events_created_at ON public.cost_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_provider ON public.cost_events (provider, created_at DESC);

-- 3. metrics_snapshot
CREATE TABLE IF NOT EXISTS public.metrics_snapshot (
  id BIGSERIAL PRIMARY KEY,
  metric_name TEXT NOT NULL,
  labels JSONB DEFAULT '{}'::jsonb,
  window_start TIMESTAMPTZ NOT NULL,
  window_seconds INTEGER NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  count INTEGER,
  min_val DOUBLE PRECISION,
  max_val DOUBLE PRECISION,
  p50 DOUBLE PRECISION,
  p95 DOUBLE PRECISION,
  p99 DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.metrics_snapshot DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.metrics_snapshot;
REVOKE ALL ON public.metrics_snapshot FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.metrics_snapshot TO service_role;

CREATE INDEX IF NOT EXISTS idx_metrics_snapshot_lookup 
  ON public.metrics_snapshot (metric_name, window_seconds, window_start DESC);

-- 3.5 aggregation_checkpoints
CREATE TABLE IF NOT EXISTS public.aggregation_checkpoints (
  id TEXT PRIMARY KEY,
  last_processed_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.aggregation_checkpoints DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aggregation_checkpoints FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.aggregation_checkpoints TO service_role;

INSERT INTO public.aggregation_checkpoints (id, last_processed_at) 
VALUES ('metrics_aggregator', NOW() - INTERVAL '1 minute') 
ON CONFLICT DO NOTHING;

-- 4. Alterations to existing tables
ALTER TABLE public.provider_health 
  ADD COLUMN IF NOT EXISTS total_tokens BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_latency_ms DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_status_code INTEGER;

ALTER TABLE public.llm_jobs 
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS cost_estimate DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_count INTEGER DEFAULT 0;

ALTER TABLE public.briefings 
  ADD COLUMN IF NOT EXISTS trace_id UUID,
  ADD COLUMN IF NOT EXISTS token_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_estimate DOUBLE PRECISION DEFAULT 0;

ALTER TABLE public.retrieval_runs 
  ADD COLUMN IF NOT EXISTS trace_id UUID;

ALTER TABLE public.connected_accounts 
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_alerted_at TIMESTAMPTZ;

ALTER TABLE public.memory_records 
  ADD COLUMN IF NOT EXISTS extraction_job_id UUID,
  ADD COLUMN IF NOT EXISTS extraction_trace_id UUID;

-- 5. RPCs for fire-and-forget inserts
CREATE OR REPLACE FUNCTION public.flush_trace_spans(spans JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.traces (
    span_id, trace_id, parent_span_id, service, operation, span_kind, 
    started_at, duration_ms, status, status_message, attributes, user_id, job_id
  )
  SELECT 
    (s->>'span_id')::uuid,
    (s->>'trace_id')::uuid,
    NULLIF(s->>'parent_span_id', '')::uuid,
    s->>'service',
    s->>'operation',
    s->>'span_kind',
    (s->>'started_at')::timestamptz,
    (s->>'duration_ms')::integer,
    s->>'status',
    s->>'status_message',
    COALESCE(s->'attributes', '{}'::jsonb),
    NULLIF(s->>'user_id', '')::uuid,
    NULLIF(s->>'job_id', '')::uuid
  FROM jsonb_array_elements(spans) AS s;
EXCEPTION
  WHEN OTHERS THEN
    -- Silently drop on error to ensure isolation
    RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.flush_trace_spans(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flush_trace_spans(JSONB) TO service_role;

-- 6. Cron Jobs
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF FOUND THEN
    -- Aggregate metrics every minute
    PERFORM cron.schedule('metrics_aggregator_job', '* * * * *', 
      $cron$
      SELECT net.http_post(
        url:='http://supabase_kong:8000/functions/v1/metrics-aggregator',
        headers:='{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds:=45000
      );
      $cron$
    );

    -- Purge traces older than 7 days, cost events older than 30 days
    PERFORM cron.schedule('trace_retention_job', '0 2 * * *', 
      $cron$
      DELETE FROM public.traces WHERE created_at < NOW() - INTERVAL '7 days';
      DELETE FROM public.cost_events WHERE created_at < NOW() - INTERVAL '30 days';
      $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule cron jobs: %', SQLERRM;
END $$;
