-- ============================================
-- Migration: Phase 13 - Retrieval feedback collection
-- ============================================
-- Stores user feedback on a retrieval result, attributed to the exact retrieval
-- variant (version / candidate limit / embedding model) and, when available,
-- the retrieval_runs row that produced it.

-- ============================================
-- UP
-- ============================================
CREATE TABLE IF NOT EXISTS public.retrieval_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES public.retrieval_runs(id) ON DELETE SET NULL,
  rating TEXT NOT NULL,             -- 'up' | 'down'
  feedback TEXT,
  retrieval_version TEXT,
  candidate_limit INTEGER,
  embedding_model TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT retrieval_evaluations_rating_chk CHECK (rating IN ('up','down'))
);

ALTER TABLE public.retrieval_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own retrieval_evaluations" ON public.retrieval_evaluations;
DROP POLICY IF EXISTS "Users can insert own retrieval_evaluations" ON public.retrieval_evaluations;
CREATE POLICY "Users can read own retrieval_evaluations" ON public.retrieval_evaluations FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own retrieval_evaluations" ON public.retrieval_evaluations FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_retrieval_evaluations_user_created
  ON public.retrieval_evaluations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_evaluations_run
  ON public.retrieval_evaluations (run_id);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP INDEX IF EXISTS public.idx_retrieval_evaluations_run;
-- DROP INDEX IF EXISTS public.idx_retrieval_evaluations_user_created;
-- DROP TABLE IF EXISTS public.retrieval_evaluations;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename='retrieval_evaluations';
