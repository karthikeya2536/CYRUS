-- ============================================
-- Migration: Phase 16 - Graph-based retrieval
-- ============================================
-- entity_mentions links memories to the entities they mention. A recursive,
-- hop- and result-limited traversal expands a set of seed memories to related
-- memories that share entities, for context expansion during retrieval.

-- ============================================
-- UP
-- ============================================
CREATE TABLE IF NOT EXISTS public.entity_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES public.memory_records(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, memory_id, entity)
);

ALTER TABLE public.entity_mentions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own entity_mentions" ON public.entity_mentions;
CREATE POLICY "Users can read own entity_mentions" ON public.entity_mentions FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_user_entity ON public.entity_mentions (user_id, lower(entity));
CREATE INDEX IF NOT EXISTS idx_entity_mentions_memory ON public.entity_mentions (memory_id);

-- Expand seed memories to related memories sharing entities, up to max_hops,
-- capped at max_results, excluding the seeds themselves. Service-role only.
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
  GROUP BY m.id, m.content, m.user_id, m.category, m.memory_key, m.created_at
  ORDER BY MIN(r.hops), m.created_at DESC
  LIMIT max_results;
$$;

REVOKE EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER) TO service_role;

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP FUNCTION IF EXISTS public.graph_expand_memories(UUID, UUID[], INTEGER, INTEGER);
-- DROP TABLE IF EXISTS public.entity_mentions;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT proname FROM pg_proc WHERE proname='graph_expand_memories';
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='entity_mentions';
