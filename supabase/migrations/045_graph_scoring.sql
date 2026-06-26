-- Migration 045: Graph Scoring Function

CREATE OR REPLACE FUNCTION public.update_graph_node_scores(node_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  node_id UUID;
  v_score INTEGER;
  v_is_stop BOOLEAN;
  v_mem_count INTEGER;
  v_edge_count INTEGER;
  v_diverse BOOLEAN;
BEGIN
  FOREACH node_id IN ARRAY node_ids LOOP
    -- 1. Check if stop entity
    SELECT is_stop_entity INTO v_is_stop FROM public.graph_nodes WHERE id = node_id;
    
    IF v_is_stop THEN
      v_score := 0;
    ELSE
      -- Base 1 for proper noun / passing stop check
      v_score := 1;
      
      -- 2. Check memories count
      SELECT count(*) INTO v_mem_count FROM public.graph_node_members WHERE graph_node_members.node_id = node_id;
      IF v_mem_count >= 2 THEN
        v_score := v_score + 1;
      END IF;

      -- 3. Check diverse sources (e.g. email + memory, or distinct categories)
      -- Using distinct categories >= 2 as a proxy for diverse sources
      SELECT (count(DISTINCT m.category) >= 2) INTO v_diverse
      FROM public.graph_node_members gnm
      JOIN public.memory_records m ON m.id = gnm.memory_id
      WHERE gnm.node_id = node_id;
      
      IF v_diverse THEN
        v_score := v_score + 1;
      END IF;

      -- 4. Check edge count
      SELECT count(*) INTO v_edge_count FROM public.graph_edges 
      WHERE source_node_id = node_id OR target_node_id = node_id;
      
      IF v_edge_count >= 1 THEN
        v_score := v_score + 1;
      END IF;
    END IF;

    -- Update the score
    UPDATE public.graph_nodes SET node_quality_score = v_score WHERE id = node_id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_graph_node_scores(UUID[]) TO service_role;
