DO $$ 
DECLARE
  v_user_id uuid;
  v_query text;
  v_rec record;
  v_seed_ids uuid[];
  v_node_keys text[];
  v_start timestamp;
  v_end timestamp;
BEGIN
  SELECT id INTO v_user_id FROM auth.users LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'No user found.';
    RETURN;
  END IF;

  -- Query 1
  v_query := 'Who is connected to Versant?';
  RAISE NOTICE '=================================================';
  RAISE NOTICE 'Query: "%"', v_query;
  RAISE NOTICE '=================================================';

  -- PATH A
  v_start := clock_timestamp();
  SELECT array_agg(id) INTO v_seed_ids FROM (
    SELECT id FROM memory_records WHERE user_id = v_user_id AND content ILIKE '%versant%' LIMIT 5
  ) t;
  
  IF v_seed_ids IS NULL THEN
    v_seed_ids := '{}';
  END IF;

  v_end := clock_timestamp();
  RAISE NOTICE '[Path A: Vector (Simulated)] Latency: % | Recalled: %', v_end - v_start, COALESCE(array_length(v_seed_ids, 1), 0);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    v_start := clock_timestamp();
    FOR v_rec IN SELECT * FROM public.graph_expand_memories(v_user_id, v_seed_ids, 2, 10) LOOP
      RAISE NOTICE '  [Path A Result] Hops: %, Content: %', v_rec.hops, substring(regexp_replace(v_rec.content, E'[\\n\\r]+', ' ', 'g') from 1 for 100);
    END LOOP;
    v_end := clock_timestamp();
    RAISE NOTICE '  [Path A: Graph Expansion] Latency: %', v_end - v_start;
  END IF;

  -- PATH B
  v_node_keys := ARRAY['versant'];
  v_start := clock_timestamp();
  SELECT array_agg(m.id) INTO v_seed_ids
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  JOIN public.memory_records m ON m.id = nm.memory_id
  WHERE n.user_id = v_user_id AND n.node_key = ANY(v_node_keys);

  IF v_seed_ids IS NULL THEN
    v_seed_ids := '{}';
  END IF;

  v_end := clock_timestamp();
  RAISE NOTICE '[Path B: Entity Node Lookup] Latency: % | Recalled: %', v_end - v_start, COALESCE(array_length(v_seed_ids, 1), 0);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    v_start := clock_timestamp();
    FOR v_rec IN SELECT * FROM public.graph_expand_memories(v_user_id, v_seed_ids, 2, 10) LOOP
      RAISE NOTICE '  [Path B Result] Hops: %, Content: %', v_rec.hops, substring(regexp_replace(v_rec.content, E'[\\n\\r]+', ' ', 'g') from 1 for 100);
    END LOOP;
    v_end := clock_timestamp();
    RAISE NOTICE '  [Path B: Graph Expansion] Latency: %', v_end - v_start;
  END IF;

  -- Query 2
  v_query := 'What is blocking xConnect?';
  RAISE NOTICE '=================================================';
  RAISE NOTICE 'Query: "%"', v_query;
  RAISE NOTICE '=================================================';

  -- PATH B
  v_node_keys := ARRAY['xconnect'];
  v_start := clock_timestamp();
  SELECT array_agg(m.id) INTO v_seed_ids
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  JOIN public.memory_records m ON m.id = nm.memory_id
  WHERE n.user_id = v_user_id AND n.node_key = ANY(v_node_keys);

  IF v_seed_ids IS NULL THEN
    v_seed_ids := '{}';
  END IF;

  v_end := clock_timestamp();
  RAISE NOTICE '[Path B: Entity Node Lookup] Latency: % | Recalled: %', v_end - v_start, COALESCE(array_length(v_seed_ids, 1), 0);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    v_start := clock_timestamp();
    FOR v_rec IN SELECT * FROM public.graph_expand_memories(v_user_id, v_seed_ids, 2, 10) LOOP
      RAISE NOTICE '  [Path B Result] Hops: %, Content: %', v_rec.hops, substring(regexp_replace(v_rec.content, E'[\\n\\r]+', ' ', 'g') from 1 for 100);
    END LOOP;
    v_end := clock_timestamp();
    RAISE NOTICE '  [Path B: Graph Expansion] Latency: %', v_end - v_start;
  END IF;

  -- Query 3
  v_query := 'What dependencies exist between contract, training data and Versant?';
  RAISE NOTICE '=================================================';
  RAISE NOTICE 'Query: "%"', v_query;
  RAISE NOTICE '=================================================';

  -- PATH B
  v_node_keys := ARRAY['contract', 'trainingdata', 'versant'];
  v_start := clock_timestamp();
  SELECT array_agg(m.id) INTO v_seed_ids
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  JOIN public.memory_records m ON m.id = nm.memory_id
  WHERE n.user_id = v_user_id AND n.node_key = ANY(v_node_keys);

  IF v_seed_ids IS NULL THEN
    v_seed_ids := '{}';
  END IF;

  v_end := clock_timestamp();
  RAISE NOTICE '[Path B: Entity Node Lookup] Latency: % | Recalled: %', v_end - v_start, COALESCE(array_length(v_seed_ids, 1), 0);

  IF COALESCE(array_length(v_seed_ids, 1), 0) > 0 THEN
    v_start := clock_timestamp();
    FOR v_rec IN SELECT * FROM public.graph_expand_memories(v_user_id, v_seed_ids, 2, 10) LOOP
      RAISE NOTICE '  [Path B Result] Hops: %, Content: %', v_rec.hops, substring(regexp_replace(v_rec.content, E'[\\n\\r]+', ' ', 'g') from 1 for 100);
    END LOOP;
    v_end := clock_timestamp();
    RAISE NOTICE '  [Path B: Graph Expansion] Latency: %', v_end - v_start;
  END IF;

END $$;
