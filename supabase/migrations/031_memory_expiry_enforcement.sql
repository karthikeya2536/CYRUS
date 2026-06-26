-- ============================================
-- Migration: 031_memory_expiry_enforcement
-- ============================================
-- Memory lifecycle enforcement.
--
-- Until now `memory_records.expires_at` was written by the extractor but read by
-- NOTHING, and the primary retrieval RPC hybrid_search_memories (migration 010)
-- filtered only by user_id -- so expired AND inactive memories were still
-- returned by search. This migration makes retrieval honor both `active` and
-- `expires_at`, which is what gives the deterministic expiration set in
-- llm-worker (processMemoryExtraction) any observable effect.
--
-- No schema changes: `active` and `expires_at` already exist on memory_records.
-- Only function bodies change. Idempotent (CREATE OR REPLACE, signatures
-- unchanged), so a clean `supabase db reset` stays green.
-- ============================================

-- ---- Primary semantic search: exclude inactive and expired memories. ----
-- (Replaces the body from migration 010; signature + grants preserved.)
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
    AND m.active = TRUE
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search_memories(TEXT, vector, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_memories TO authenticated;

-- ---- Graph expansion: already filtered active; now also exclude expired. ----
-- (Replaces the body from migration 021; signature + grants preserved.)
CREATE OR REPLACE FUNCTION public.graph_expand_memories(
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
  hops INTEGER
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
  SELECT m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at, MIN(r.hops) AS hops
  FROM reach r
  JOIN public.memory_records m ON m.id = r.mid AND m.user_id = p_user_id AND m.active = TRUE
  WHERE r.mid <> ALL (seed_ids)        -- never re-emit the seeds
    AND (m.expires_at IS NULL OR m.expires_at > now())
  GROUP BY m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at
  ORDER BY MIN(r.hops), m.created_at DESC
  LIMIT max_results;
$$;

REVOKE EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) TO service_role;

-- ============================================
-- ROLLBACK
-- ============================================
-- Re-apply the bodies from migration 010 (hybrid_search_memories) and 021
-- (graph_expand_memories), which omit the `active` / `expires_at` guards.

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('hybrid_search_memories','graph_expand_memories');
--   -- Expired/inactive rows must not appear:
--   -- SELECT * FROM hybrid_search_memories('x', <emb>, 30);
