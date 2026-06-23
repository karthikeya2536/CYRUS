-- ============================================
-- Migration: 032_retrieval_ranking_signals
-- ============================================
-- Adds ranking signals used by retrieve-context/ranker.ts:
--   reinforcement (retrieval_count, last_retrieved_at),
--   temporal urgency (deadline_at),
-- surfaces importance + these signals from the memory search RPCs, and adds a
-- batched reinforcement writer. Idempotent; a clean `supabase db reset` stays green.
-- last_retrieved_at is stored for observability only (not a V1 scoring signal).
-- ============================================

ALTER TABLE public.memory_records ADD COLUMN IF NOT EXISTS retrieval_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.memory_records ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;
ALTER TABLE public.memory_records ADD COLUMN IF NOT EXISTS deadline_at       TIMESTAMPTZ;

-- ---- Primary semantic search: surface importance + ranking signals. ----
-- Return shape changes, so DROP before CREATE (CREATE OR REPLACE cannot alter OUT cols).
DROP FUNCTION IF EXISTS public.hybrid_search_memories(TEXT, vector, INTEGER);
CREATE FUNCTION public.hybrid_search_memories(
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
  similarity_distance FLOAT,
  llm_importance NUMERIC,
  system_importance NUMERIC,
  retrieval_count INTEGER,
  last_retrieved_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at,
    m.embedding <=> query_embedding AS similarity_distance,
    m.llm_importance, m.system_importance,
    m.retrieval_count, m.last_retrieved_at, m.deadline_at
  FROM public.memory_records m
  WHERE m.user_id = auth.uid()
    AND m.active = TRUE
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_memories(TEXT, vector, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_memories TO authenticated;

-- ---- Graph expansion: surface the same signals. ----
DROP FUNCTION IF EXISTS public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER);
CREATE FUNCTION public.graph_expand_memories(
  p_user_id UUID,
  seed_ids UUID[],
  max_hops INTEGER DEFAULT 2,
  max_results INTEGER DEFAULT 25
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  user_id UUID,
  category TEXT,
  memory_key TEXT,
  created_at TIMESTAMPTZ,
  hops INTEGER,
  llm_importance NUMERIC,
  system_importance NUMERIC,
  retrieval_count INTEGER,
  last_retrieved_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  WITH RECURSIVE reach(mid, hops) AS (
    SELECT s, 0 FROM unnest(seed_ids) AS s
    UNION
    SELECT em2.memory_id, r.hops + 1
    FROM reach r
    JOIN public.entity_mentions em1 ON em1.memory_id = r.mid AND em1.user_id = p_user_id
    JOIN public.entity_mentions em2
      ON lower(em2.entity) = lower(em1.entity)
     AND em2.user_id = p_user_id
     AND em2.memory_id <> r.mid
    WHERE r.hops < max_hops
  )
  SELECT m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at,
         MIN(r.hops) AS hops,
         m.llm_importance, m.system_importance,
         m.retrieval_count, m.last_retrieved_at, m.deadline_at
  FROM reach r
  JOIN public.memory_records m ON m.id = r.mid AND m.user_id = p_user_id AND m.active = TRUE
  WHERE r.mid <> ALL (seed_ids)
    AND (m.expires_at IS NULL OR m.expires_at > now())
  GROUP BY m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at,
           m.llm_importance, m.system_importance, m.retrieval_count,
           m.last_retrieved_at, m.deadline_at
  ORDER BY MIN(r.hops), m.created_at DESC
  LIMIT max_results;
$$;
REVOKE EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) TO service_role;

-- ---- Batched reinforcement writer (single UPDATE; user-scoped). ----
CREATE OR REPLACE FUNCTION public.record_memory_retrievals(p_user_id UUID, ids UUID[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  UPDATE public.memory_records
  SET retrieval_count = retrieval_count + 1,
      last_retrieved_at = now()
  WHERE id = ANY(ids) AND user_id = p_user_id;
$$;
REVOKE EXECUTE ON FUNCTION public.record_memory_retrievals(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_memory_retrievals(UUID, UUID[]) TO service_role;

-- ============================================
-- ROLLBACK: drop deadline_at/retrieval_count/last_retrieved_at columns and
-- re-apply migration 031 bodies of the two search functions; drop record_memory_retrievals.
-- ============================================
