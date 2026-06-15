-- ============================================
-- Migration: Reconstruct missing schema
-- ============================================
-- The tables memory_records, llm_jobs, provider_health and briefings are
-- referenced throughout supabase/functions/** but have no DDL in the repo.
-- This migration reconstructs their CREATE TABLE definitions from every column
-- referenced in the function code, enables RLS, and adds per-user policies.
--
-- Columns collected from:
--   memory_records  -> llm-worker/index.ts (insert ~L215, update ~L206, select ~L196,
--                      briefing select ~L294), system-validation/index.ts (L48, L246, L385),
--                      retrieve-context (via hybrid_search_memories / assembler.ts)
--   llm_jobs        -> llm-worker/index.ts (fetch/update/insert), memory-extraction,
--                      generate-briefing, system-validation
--   provider_health -> _shared/llm-router.ts (getProviderHealth/updateProviderHealth),
--                      system-validation/index.ts (test2to4, test7)
--   briefings       -> llm-worker/index.ts (insert ~L349), system-validation (test8)
--
-- pgvector required for memory_records.embedding (vector(768)).

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- UP
-- ============================================

-- --------------------------------------------
-- memory_records
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT,
  content TEXT NOT NULL,
  memory_key TEXT,
  source_type TEXT,
  source_id TEXT,
  source_hash TEXT,
  confidence_score NUMERIC DEFAULT 0,
  llm_provider TEXT,
  verifier_provider TEXT,
  verified BOOLEAN DEFAULT FALSE,
  verification_score NUMERIC,
  evidence JSONB DEFAULT '[]'::jsonb,
  source_excerpt TEXT,
  expires_at TIMESTAMPTZ,
  llm_importance NUMERIC DEFAULT 0.5,
  system_importance NUMERIC DEFAULT 0.5,
  occurrence_count INTEGER DEFAULT 1,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  active BOOLEAN DEFAULT TRUE,
  embedding vector(768),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- llm-worker upserts by (user_id, category, memory_key); enforce that key.
  UNIQUE (user_id, category, memory_key)
);

ALTER TABLE public.memory_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own memory_records" ON public.memory_records;
DROP POLICY IF EXISTS "Users can insert own memory_records" ON public.memory_records;
DROP POLICY IF EXISTS "Users can update own memory_records" ON public.memory_records;
DROP POLICY IF EXISTS "Users can delete own memory_records" ON public.memory_records;

CREATE POLICY "Users can read own memory_records" ON public.memory_records FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own memory_records" ON public.memory_records FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own memory_records" ON public.memory_records FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own memory_records" ON public.memory_records FOR DELETE USING (auth.uid() = user_id);

-- --------------------------------------------
-- llm_jobs
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.llm_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  priority INTEGER DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.llm_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own llm_jobs" ON public.llm_jobs;
DROP POLICY IF EXISTS "Users can insert own llm_jobs" ON public.llm_jobs;
DROP POLICY IF EXISTS "Users can update own llm_jobs" ON public.llm_jobs;
DROP POLICY IF EXISTS "Users can delete own llm_jobs" ON public.llm_jobs;

CREATE POLICY "Users can read own llm_jobs" ON public.llm_jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own llm_jobs" ON public.llm_jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own llm_jobs" ON public.llm_jobs FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own llm_jobs" ON public.llm_jobs FOR DELETE USING (auth.uid() = user_id);

-- --------------------------------------------
-- provider_health (service-role only: NO user policies, RLS enabled)
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_health (
  provider_name TEXT PRIMARY KEY,
  failure_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  timeout_count INTEGER DEFAULT 0,
  rate_limit_count INTEGER DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  last_success TIMESTAMPTZ,
  last_failure TIMESTAMPTZ
);

ALTER TABLE public.provider_health ENABLE ROW LEVEL SECURITY;
-- No RLS policies: this table is global health state, touched only by the
-- service role (LLMRouter, system-validation). RLS-enabled with no policy
-- denies all access to authenticated/anon while service_role bypasses RLS.

-- --------------------------------------------
-- briefings
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT,
  email_count_used INTEGER DEFAULT 0,
  event_count_used INTEGER DEFAULT 0,
  generator_provider TEXT,
  verifier_provider TEXT,
  generation_metadata JSONB,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.briefings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own briefings" ON public.briefings;
DROP POLICY IF EXISTS "Users can delete own briefings" ON public.briefings;

-- Briefings are authored by the worker (service role); users only read/delete.
CREATE POLICY "Users can read own briefings" ON public.briefings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own briefings" ON public.briefings FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- ROLLBACK
-- ============================================
-- WARNING: dropping these tables destroys data. Only for clean reverts.
--
-- DROP TABLE IF EXISTS public.briefings;
-- DROP TABLE IF EXISTS public.provider_health;
-- DROP TABLE IF EXISTS public.llm_jobs;
-- DROP TABLE IF EXISTS public.memory_records;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename IN ('memory_records','llm_jobs','provider_health','briefings');
--   SELECT tablename, policyname FROM pg_policies WHERE schemaname='public'
--     AND tablename IN ('memory_records','llm_jobs','provider_health','briefings');
-- Expect rowsecurity=true for all four; provider_health has zero policies.
