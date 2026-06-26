-- 1. Check specific nodes
SELECT id, node_key, node_type, is_stop_entity, node_quality_score
FROM public.graph_nodes
WHERE node_key IN (
  'versant',
  'xconnect',
  'gunashreerajendran',
  'basitiqbal',
  'trainingdata'
);

-- 2. Check edges for versant
SELECT
  e.relationship_type,
  s.node_key AS source,
  t.node_key AS target,
  e.confidence
FROM public.graph_edges e
JOIN public.graph_nodes s ON s.id = e.source_node_id
JOIN public.graph_nodes t ON t.id = e.target_node_id
WHERE s.node_key = 'versant' OR t.node_key = 'versant';

-- 3. Check graph_build_audit edge density
SELECT
  status,
  sum(nodes_created) as total_nodes,
  sum(edges_created) as total_edges,
  CASE WHEN sum(nodes_created) > 0 THEN sum(edges_created)::float / sum(nodes_created) ELSE 0 END as edge_ratio
FROM public.graph_build_audit
GROUP BY status;

-- 4. Check total counts
SELECT count(*) as total_nodes FROM public.graph_nodes;
SELECT count(*) as total_edges FROM public.graph_edges;
