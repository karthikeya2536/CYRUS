DO $$ 
DECLARE
  v_user_id uuid;
  v_query text;
  v_rec record;
  v_seed_ids uuid[];
  v_node_keys text[];
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS test_logs (msg text);
  TRUNCATE test_logs;

  SELECT id INTO v_user_id FROM auth.users WHERE email = 'yemulakarthikeya@gmail.com' LIMIT 1;
  IF v_user_id IS NULL THEN
    INSERT INTO test_logs VALUES ('No user found.');
    RETURN;
  END IF;

  -- Test 1
  v_query := 'What is blocking xConnect?';
  INSERT INTO test_logs VALUES ('=================================================');
  INSERT INTO test_logs VALUES ('Query: "' || v_query || '"');
  
  v_node_keys := ARRAY['xconnect'];
  SELECT array_agg(m.id) INTO v_seed_ids
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  JOIN public.memory_records m ON m.id = nm.memory_id
  WHERE n.user_id = v_user_id AND n.node_key = ANY(v_node_keys);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    INSERT INTO test_logs VALUES ('Graph Relations for ' || v_query || ' (Seed Memories: ' || array_length(v_seed_ids, 1) || '):');
    
    -- Resolve Node IDs from memory IDs
    SELECT array_agg(node_id) INTO v_seed_ids FROM public.graph_node_members WHERE memory_id = ANY(v_seed_ids);

    FOR v_rec IN SELECT * FROM public.graph_render_relations(v_user_id, v_seed_ids, 2, 5) LOOP
      INSERT INTO test_logs VALUES ('  [Graph Relation] ' || v_rec.source_node || ' ' || v_rec.relationship_type || ' ' || v_rec.target_node || ' (score: ' || v_rec.score || ')');
    END LOOP;
  ELSE
    INSERT INTO test_logs VALUES ('No seed memories found.');
  END IF;

  -- Test 2
  v_query := 'Who is involved in xConnect?';
  INSERT INTO test_logs VALUES ('=================================================');
  INSERT INTO test_logs VALUES ('Query: "' || v_query || '"');
  
  v_node_keys := ARRAY['xconnect'];
  SELECT array_agg(m.id) INTO v_seed_ids
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  JOIN public.memory_records m ON m.id = nm.memory_id
  WHERE n.user_id = v_user_id AND n.node_key = ANY(v_node_keys);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    INSERT INTO test_logs VALUES ('Graph Relations for ' || v_query || ' (Seed Memories: ' || array_length(v_seed_ids, 1) || '):');
    
    -- Resolve Node IDs from memory IDs
    SELECT array_agg(node_id) INTO v_seed_ids FROM public.graph_node_members WHERE memory_id = ANY(v_seed_ids);

    FOR v_rec IN SELECT * FROM public.graph_render_relations(v_user_id, v_seed_ids, 2, 5) LOOP
      INSERT INTO test_logs VALUES ('  [Graph Relation] ' || v_rec.source_node || ' ' || v_rec.relationship_type || ' ' || v_rec.target_node || ' (score: ' || v_rec.score || ')');
    END LOOP;
  ELSE
    INSERT INTO test_logs VALUES ('No seed memories found.');
  END IF;

  -- Test 3
  v_query := 'What dependencies exist between contract, training data and Versant?';
  INSERT INTO test_logs VALUES ('=================================================');
  INSERT INTO test_logs VALUES ('Query: "' || v_query || '"');
  
  v_node_keys := ARRAY['contract', 'trainingdata', 'versant'];
  SELECT array_agg(m.id) INTO v_seed_ids
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  JOIN public.memory_records m ON m.id = nm.memory_id
  WHERE n.user_id = v_user_id AND n.node_key = ANY(v_node_keys);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    INSERT INTO test_logs VALUES ('Graph Relations for ' || v_query || ' (Seed Memories: ' || array_length(v_seed_ids, 1) || '):');
    
    -- Resolve Node IDs from memory IDs
    SELECT array_agg(node_id) INTO v_seed_ids FROM public.graph_node_members WHERE memory_id = ANY(v_seed_ids);

    FOR v_rec IN SELECT * FROM public.graph_render_relations(v_user_id, v_seed_ids, 2, 5) LOOP
      INSERT INTO test_logs VALUES ('  [Graph Relation] ' || v_rec.source_node || ' ' || v_rec.relationship_type || ' ' || v_rec.target_node || ' (score: ' || v_rec.score || ')');
    END LOOP;
  ELSE
    INSERT INTO test_logs VALUES ('No seed memories found.');
  END IF;

END $$;

SELECT * FROM test_logs;
