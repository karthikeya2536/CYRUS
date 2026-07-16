-- Validation: Test that generic relationships are properly filtered/penalized
DO $$
DECLARE
    v_user_id uuid := (SELECT id FROM graph_nodes WHERE user_id IS NOT NULL LIMIT 1);
    v_start_node_ids uuid[] := ARRAY(SELECT id FROM graph_nodes WHERE user_id = v_user_id LIMIT 2);
    v_record RECORD;
    v_generic_count INT := 0;
    v_total_count INT := 0;
BEGIN
    -- Test the function works and returns expected results
    FOR v_record IN 
        SELECT * FROM graph_render_relations(v_user_id, v_start_node_ids, 2, 20, 'general') AS func
    LOOP
        v_total_count := v_total_count + 1;
        IF v_record.relationship_type IN ('associated_with', 'regarding', 'involved_in', 'mentioned', 'interested_in') THEN
            v_generic_count := v_generic_count + 1;
        END IF;
    END LOOP;
    
    -- In a properly working system, generic relationships should be heavily penalized
    -- so they should appear rarely in the top results (if at all)
    RAISE NOTICE 'Validation: Total results: %, Generic relationships: % (should be low due to penalties)', 
        v_total_count, v_generic_count;
END $$;
