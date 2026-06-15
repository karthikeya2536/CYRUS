-- ============================================
-- Migration: Reconstruct log tables
-- ============================================
-- memory_extraction_logs and retrieval_logs are referenced in functions but
-- have no DDL in the repo. Columns collected from:
--   memory_extraction_logs -> llm-worker/index.ts (insert ~L184: source_id,
--                             extractor_provider, verifier_provider, decision,
--                             confidence), system-validation (select 'decision'
--                             and 'extractor_provider,verifier_provider',
--                             order by 'timestamp')
--   retrieval_logs         -> retrieve-context/index.ts (insert ~L111: query,
--                             intent, entities, results_count, latency_ms),
--                             inserted via the USER client (RLS enforced)

-- ============================================
-- UP
-- ============================================

-- --------------------------------------------
-- memory_extraction_logs
-- Written by the worker (service role); read by system-validation (service
-- role). No user_id column is set by the code, so this is service-role-only:
-- RLS enabled with no policies denies authenticated/anon; service_role bypasses.
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_extraction_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT,
  extractor_provider TEXT,
  verifier_provider TEXT,
  decision TEXT,
  confidence NUMERIC,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.memory_extraction_logs ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.

-- --------------------------------------------
-- retrieval_logs
-- Inserted via the user-scoped client in retrieve-context. The insert does NOT
-- supply user_id, so user_id defaults to auth.uid() and the RLS WITH CHECK
-- passes. Users may read their own rows.
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.retrieval_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  query TEXT,
  intent TEXT,
  entities JSONB,
  results_count INTEGER,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.retrieval_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own retrieval_logs" ON public.retrieval_logs;
DROP POLICY IF EXISTS "Users can insert own retrieval_logs" ON public.retrieval_logs;

CREATE POLICY "Users can read own retrieval_logs" ON public.retrieval_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own retrieval_logs" ON public.retrieval_logs FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP TABLE IF EXISTS public.retrieval_logs;
-- DROP TABLE IF EXISTS public.memory_extraction_logs;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename IN ('memory_extraction_logs','retrieval_logs');
-- Expect rowsecurity=true for both; memory_extraction_logs has zero policies.
