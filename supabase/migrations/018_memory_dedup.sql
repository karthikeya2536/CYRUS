-- ============================================
-- Migration: Phase 14 - Safe memory de-duplication
-- ============================================
-- Adds a category-guarded vector candidate search RPC and a merge audit trail.
-- Safety: this migration never deletes or overwrites memory content; merges are
-- recorded here and the canonical row is only incremented by the worker.

-- ============================================
-- UP
-- ============================================

-- Top-N nearest existing memories WITHIN THE SAME CATEGORY for a user. The
-- category equality is the hard guard that makes cross-category merges
-- impossible. Service-role only (called by llm-worker with the user id).
CREATE OR REPLACE FUNCTION public.match_memory_candidates(
  p_user_id UUID,
  p_category TEXT,
  query_embedding vector(768),
  match_count INTEGER DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  occurrence_count INTEGER,
  confidence_score NUMERIC,
  distance FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT
    m.id,
    m.content,
    m.occurrence_count,
    m.confidence_score,
    (m.embedding <=> query_embedding) AS distance
  FROM public.memory_records m
  WHERE m.user_id = p_user_id
    AND m.category = p_category           -- category guard: never cross categories
    AND m.active = TRUE
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION public.match_memory_candidates(UUID, TEXT, vector, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_memory_candidates(UUID, TEXT, vector, INTEGER) TO service_role;

-- Append-only merge audit trail. One row per dedup decision the worker makes.
CREATE TABLE IF NOT EXISTS public.memory_merge_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  canonical_id UUID NOT NULL REFERENCES public.memory_records(id) ON DELETE CASCADE,
  category TEXT,
  duplicate_content TEXT,
  duplicate_source_id TEXT,
  similarity_distance FLOAT,
  decision TEXT,            -- 'merged' | 'kept_separate'
  adjudicator TEXT,         -- LLM provider name or 'threshold'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.memory_merge_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own merge audit" ON public.memory_merge_audit;
-- Read-only for users; the worker (service role) writes. No delete/update policy.
CREATE POLICY "Users can read own merge audit" ON public.memory_merge_audit FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_memory_merge_audit_user
  ON public.memory_merge_audit (user_id, created_at DESC);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP INDEX IF EXISTS public.idx_memory_merge_audit_user;
-- DROP TABLE IF EXISTS public.memory_merge_audit;
-- DROP FUNCTION IF EXISTS public.match_memory_candidates(UUID, TEXT, vector, INTEGER);

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT proname FROM pg_proc WHERE proname='match_memory_candidates';
--   SELECT tablename, rowsecurity FROM pg_tables
--     WHERE schemaname='public' AND tablename='memory_merge_audit';
