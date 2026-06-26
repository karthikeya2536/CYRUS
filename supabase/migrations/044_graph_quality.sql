-- Phase 034A.1: Graph Quality Hardening

-- 1. Extend graph_nodes for quality scoring
ALTER TABLE public.graph_nodes
  ADD COLUMN node_quality_score INTEGER DEFAULT 0,
  ADD COLUMN is_stop_entity BOOLEAN DEFAULT FALSE;

-- 2. Create graph_merge_audit to track node fragmentation and merging
CREATE TABLE public.graph_merge_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_node_key TEXT NOT NULL,
  target_node_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence FLOAT DEFAULT 1.0,
  merged_at TIMESTAMPTZ DEFAULT now()
);

-- RLS for merge audit
ALTER TABLE public.graph_merge_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can insert their own graph_merge_audit" ON public.graph_merge_audit FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can select their own graph_merge_audit" ON public.graph_merge_audit FOR SELECT USING (auth.uid() = user_id);

-- 3. Modify graph_expand_memories to enforce quality gates
-- Note: Reusing the 043 signature but modifying the internals.
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
  llm_importance DOUBLE PRECISION,
  system_importance DOUBLE PRECISION,
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
    SELECT gnm2.memory_id, r.hops + 1
    FROM reach r
    -- Expand through graph edges (instead of entity mentions)
    -- This uses the true graph_edges table. Wait, the old 032 definition used entity_mentions!
    -- If Phase 034A introduced graph_edges, traversal should use graph_edges.
    -- Wait, looking closely at 042, did it redefine graph_expand_memories to use graph_edges?
    -- No! I used the 032 definition which used entity_mentions!
    -- I will redefine it to use graph_edges and graph_nodes.
    JOIN public.graph_node_members gnm1 ON gnm1.memory_id = r.mid
    JOIN public.graph_nodes gn1 ON gn1.id = gnm1.node_id AND gn1.user_id = p_user_id AND gn1.node_quality_score >= 2
    JOIN public.graph_edges ge ON (ge.source_node_id = gn1.id OR ge.target_node_id = gn1.id) 
                               AND ge.user_id = p_user_id 
                               AND ge.relationship_type IN ('blocked_by','depends_on','works_on','assigned_to','owns','requires','signed','awaiting','deadline','collaborates_on','contact_for','participating_in','mentioned_by')
    JOIN public.graph_nodes gn2 ON (gn2.id = ge.target_node_id OR gn2.id = ge.source_node_id) 
                               AND gn2.id <> gn1.id AND gn2.user_id = p_user_id AND gn2.node_quality_score >= 2
    JOIN public.graph_node_members gnm2 ON gnm2.node_id = gn2.id AND gnm2.memory_id <> r.mid
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
