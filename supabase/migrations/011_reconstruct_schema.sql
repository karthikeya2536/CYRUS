-- ============================================
-- Migration: 011_reconstruct_schema.sql
-- ============================================
-- This migration reconstructs the base schema for the Cyrus V2 application.
-- NOTE: provider_health table has been removed and replaced with OmniRoute.

-- --------------------------------------------
-- memories
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  source_type TEXT DEFAULT 'unknown',
  source_id TEXT,
  source_hash TEXT,
  confidence_score INTEGER DEFAULT 0,
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
-- provider_health table removed - replaced by OmniRoute
-- --------------------------------------------
-- The provider_health table has been removed as part of the migration to OmniRoute.
-- LLM provider health and routing is now handled entirely by the OmniRoute service.

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
-- DROP TABLE IF EXISTS public.llm_jobs;
-- DROP TABLE IF EXISTS public.memory_records;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename IN ('memory_records','llm_jobs','briefings');
--   SELECT tablename, policyname FROM pg_policies WHERE schemaname='public'
--     AND tablename IN ('memory_records','llm_jobs','briefings');
-- Expect rowsecurity=true for all three tables.