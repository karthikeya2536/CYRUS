WITH node_stats AS (
  SELECT count(*) as total_nodes,
         count(*) FILTER (WHERE is_stop_entity = true) as generic_nodes,
         count(DISTINCT node_key) as unique_nodes
  FROM public.graph_nodes
),
edge_stats AS (
  SELECT count(*) as total_edges
  FROM public.graph_edges
)
SELECT 
  total_nodes,
  total_edges,
  generic_nodes,
  ROUND(total_edges::numeric / NULLIF(total_nodes, 0), 2) as edges_per_node,
  ROUND((total_nodes - unique_nodes)::numeric / NULLIF(total_nodes, 0) * 100, 2) as duplicate_node_ratio,
  ROUND(generic_nodes::numeric / NULLIF(total_nodes, 0) * 100, 2) as generic_node_ratio
FROM node_stats, edge_stats;
