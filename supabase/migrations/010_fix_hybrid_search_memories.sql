-- ============================================
-- Migration: Fix hybrid_search_memories table mismatch
-- ============================================
-- 008 defined hybrid_search_memories to read FROM public.memories with a
-- non-existent column (memory_type). The real table is public.memory_records.
-- This migration drops and recreates the function against memory_records with
-- the correct columns.
--
-- Columns verified against:
--   supabase/functions/llm-worker/index.ts (insert ~L215, update ~L206, embedding update ~L263)
--   supabase/functions/retrieve-context/index.ts (rpc call + ranker.ts/assembler.ts consumption)
--   supabase/functions/system-validation/index.ts
--
-- The retrieve-context pipeline (assembler.ts) routes a row as a "memory" when
-- it has a `memory_key`, and renders `[Memory - <category>] <content>`. So the
-- RETURNS TABLE exposes id, content, user_id, category (the type field),
-- memory_key, created_at and similarity_distance.

-- ============================================
-- UP
-- ============================================

DROP FUNCTION IF EXISTS public.hybrid_search_memories(TEXT, vector, INTEGER);

CREATE OR REPLACE FUNCTION public.hybrid_search_memories(
  query_text TEXT,
  query_embedding vector(768),
  match_count INTEGER DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  user_id UUID,
  category TEXT,
  memory_key TEXT,
  created_at TIMESTAMPTZ,
  similarity_distance FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.user_id,
    m.category,
    m.memory_key,
    m.created_at,
    m.embedding <=> query_embedding AS similarity_distance
  FROM public.memory_records m
  WHERE m.user_id = auth.uid()  -- ENFORCE USER ISOLATION
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- DROP above recreates the function fresh, which re-applies Supabase's default
-- EXECUTE grant to anon; revoke it so only authenticated may call this RPC.
REVOKE EXECUTE ON FUNCTION public.hybrid_search_memories(TEXT, vector, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_memories TO authenticated;

-- ============================================
-- ROLLBACK
-- ============================================
-- Restores the prior (broken) 008 definition reading FROM public.memories.
--
-- DROP FUNCTION IF EXISTS public.hybrid_search_memories(TEXT, vector, INTEGER);
--
-- CREATE OR REPLACE FUNCTION public.hybrid_search_memories(
--   query_text TEXT,
--   query_embedding vector(768),
--   match_count INTEGER DEFAULT 30
-- )
-- RETURNS TABLE (
--   id UUID,
--   content TEXT,
--   user_id UUID,
--   memory_type TEXT,
--   created_at TIMESTAMPTZ,
--   similarity_distance FLOAT
-- )
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = 'public'
-- AS $$
-- BEGIN
--   RETURN QUERY
--   SELECT
--     m.id,
--     m.content,
--     m.user_id,
--     m.memory_type,
--     m.created_at,
--     m.embedding <=> query_embedding AS similarity_distance
--   FROM public.memories m
--   WHERE m.user_id = auth.uid()
--   ORDER BY m.embedding <=> query_embedding
--   LIMIT match_count;
-- END;
-- $$;
--
-- GRANT EXECUTE ON FUNCTION public.hybrid_search_memories TO authenticated;

-- ============================================
-- VERIFICATION
-- ============================================
-- After applying, confirm the function resolves against the real table:
--   SELECT * FROM public.hybrid_search_memories(
--     'test', ('[' || array_to_string(array_fill(0::float, ARRAY[768]), ',') || ']')::vector, 5
--   );
-- (Run as an authenticated user; returns only that user's memory_records.)
