-- Fix Migration 045: Graph Scoring Function with correct variable name

CREATE OR REPLACE FUNCTION public.update_graph_node_scores(node_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_n_id UUID;
  v_score INTEGER;
  v_is_stop BOOLEAN;
  v_mem_count INTEGER;
  v_edge_count INTEGER;
  v_diverse BOOLEAN;
BEGIN
  FOREACH v_n_id IN ARRAY node_ids LOOP
    -- 1. Check if stop entity
    SELECT is_stop_entity INTO v_is_stop FROM public.graph_nodes WHERE id = v_n_id;
    
    IF v_is_stop THEN
      v_score := 0;
    ELSE
      -- Base 1 for proper noun / passing stop check
      v_score := 1;
      
      -- 2. Check memories count
      SELECT count(*) INTO v_mem_count FROM public.graph_node_members WHERE node_id = v_n_id;
      IF v_mem_count >= 2 THEN
        v_score := v_score + 1;
      END IF;

      -- 3. Check diverse sources (e.g. email + memory, or distinct categories)
      SELECT (count(DISTINCT m.category) >= 2) INTO v_diverse
      FROM public.graph_node_members gnm
      JOIN public.memory_records m ON m.id = gnm.memory_id
      WHERE gnm.node_id = v_n_id;
      
      IF v_diverse THEN
        v_score := v_score + 1;
      END IF;

      -- 4. Check edge count
      SELECT count(*) INTO v_edge_count FROM public.graph_edges 
      WHERE source_node_id = v_n_id OR target_node_id = v_n_id;
      
      IF v_edge_count >= 1 THEN
        v_score := v_score + 1;
      END IF;
    END IF;

    -- Update the score
    UPDATE public.graph_nodes SET node_quality_score = v_score WHERE id = v_n_id;
  END LOOP;
END;
$$;

-- Backfill is_stop_entity
UPDATE public.graph_nodes
SET is_stop_entity = true
WHERE node_key IN (
  'user', 'users', 'person', 'people', 'professional', 'speaker', 'individual', 
  'contact', 'email', 'document', 'resource', 'project', 'task', 'event', 
  'meeting', 'communication', 'communication_thread', 'platform', 'organization', 
  'company', 'group', 'role', 'domain', 'technology', 'skill', 'date', 
  'artifact', 'location', 'application', 'process'
);

-- Backfill node scores using the RPC
DO $$
DECLARE
  v_node_ids UUID[];
BEGIN
  SELECT array_agg(id) INTO v_node_ids FROM public.graph_nodes;
  IF v_node_ids IS NOT NULL THEN
    PERFORM public.update_graph_node_scores(v_node_ids);
  END IF;
END $$;
