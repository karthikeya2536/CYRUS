WITH q1 AS (
  SELECT 
    'Path A (Versant)' as path,
    array_length(array_agg(m.id), 1) as seed_count,
    (SELECT count(*) FROM public.graph_expand_memories(
        (SELECT '02290b23-3147-4994-96b8-7881ea39bb4a'::uuid),
        array_agg(m.id),
        2, 10
    )) as expanded_count
  FROM memory_records m
  WHERE m.user_id = (SELECT '02290b23-3147-4994-96b8-7881ea39bb4a'::uuid)
    AND m.content ILIKE '%versant%'
),
q2 AS (
  SELECT 
    'Path B (Versant)' as path,
    array_length(array_agg(DISTINCT nm.memory_id), 1) as seed_count,
    (SELECT count(*) FROM public.graph_expand_memories(
        (SELECT '02290b23-3147-4994-96b8-7881ea39bb4a'::uuid),
        array_agg(DISTINCT nm.memory_id),
        2, 10
    )) as expanded_count
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  WHERE n.user_id = (SELECT '02290b23-3147-4994-96b8-7881ea39bb4a'::uuid)
    AND n.node_key = 'versant'
),
q3 AS (
  SELECT 
    'Path B (xConnect)' as path,
    array_length(array_agg(DISTINCT nm.memory_id), 1) as seed_count,
    (SELECT count(*) FROM public.graph_expand_memories(
        (SELECT '02290b23-3147-4994-96b8-7881ea39bb4a'::uuid),
        array_agg(DISTINCT nm.memory_id),
        2, 10
    )) as expanded_count
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  WHERE n.user_id = (SELECT id FROM auth.users LIMIT 1)
    AND n.node_key = 'xconnect'
),
q4 AS (
  SELECT 
    'Path B (contract, trainingdata, versant)' as path,
    array_length(array_agg(DISTINCT nm.memory_id), 1) as seed_count,
    (SELECT count(*) FROM public.graph_expand_memories(
        (SELECT id FROM auth.users LIMIT 1),
        array_agg(DISTINCT nm.memory_id),
        2, 10
    )) as expanded_count
  FROM public.graph_nodes n
  JOIN public.graph_node_members nm ON n.id = nm.node_id
  WHERE n.user_id = (SELECT id FROM auth.users LIMIT 1)
    AND n.node_key IN ('contract', 'trainingdata', 'versant')
)
SELECT * FROM q1
UNION ALL
SELECT * FROM q2
UNION ALL
SELECT * FROM q3
UNION ALL
SELECT * FROM q4;
