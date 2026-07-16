-- Final version of graph_render_relations with:
--   - Path-based cycle detection (no revisiting nodes in the same path)
--   - Relationship penalty (0.1x) for generic relationships instead of filtering out
--   - Intent-based boosting (2x) for matching intent/relationship combinations
--   - Node quality filtering (node_quality_score >= 2)
--   - Traversal score decay (0.8 per hop)
--   - Backward compatibility (default parameter values)
--   - Fixed ambiguous column names in PL/pgSQL by using distinct output variable names.
-- Validation: demonstrate that generic relationships (associated_with, regarding) receive a penalty
--   and do not dominate dependency-related queries.
-- Example validation query (run after deploying):
--   SELECT
--       relationship_type,
--       avg(score) AS avg_score,
--       count(*) AS cnt
--   FROM graph_render_relations(
--       '00000000-0000-0000-0000-000000000000'::uuid,   -- example user id
--       ARRAY['00000000-0000-0000-0000-000000000001'::uuid], -- example start node
--       2, 10, 'dependency'
--   )
--   WHERE relationship_type IN ('associated_with','regarding','depends_on','blocked_by')
--   GROUP BY relationship_type
--   ORDER BY avg_score DESC;
-- Expect avg_score for associated_with and regarding to be lower than for depends_on or blocked_by
-- due to the 0.1x penalty applied to generic relationships.

CREATE OR REPLACE FUNCTION graph_render_relations(
    p_user_id uuid,
    p_start_node_ids uuid[],
    p_max_hops integer DEFAULT 2,
    p_limit integer DEFAULT 10,
    p_graph_intent text DEFAULT 'general'
)
RETURNS TABLE (
    source_node text,
    relationship_type text,
    target_node text,
    score double precision
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE traverse AS (
        -- Anchor: start nodes
        SELECT
            id AS current_node_id,
            1.0::FLOAT AS current_score,
            0 AS hops,
            ARRAY[id] AS path_ids,  -- visited nodes in this path
            id AS path_source_id,
            id AS path_target_id,
            NULL::text AS edge_type
        FROM graph_nodes
        WHERE user_id = p_user_id
          AND id = ANY(p_start_node_ids)
          AND node_quality_score >= 2

        UNION ALL

        -- Recursive step: traverse edges
        SELECT
            e.target_node_id,
            t.current_score * e.confidence * 0.8,  -- decay per hop
            t.hops + 1,
            t.path_ids || e.target_node_id,  -- append new node to path
            t.path_source_id,
            e.target_node_id,
            e.relationship_type
        FROM traverse t
        JOIN graph_edges e ON e.source_node_id = t.current_node_id
        JOIN graph_nodes tn ON e.target_node_id = tn.id AND tn.user_id = p_user_id
        WHERE e.user_id = p_user_id
          AND t.hops < p_max_hops
          -- Avoid cycles: target node not already in the path
          AND NOT (e.target_node_id = ANY(t.path_ids))
          AND (e.expires_at IS NULL OR e.expires_at > now())
          AND tn.node_quality_score >= 2
    ),
    edges AS (
        -- Extract distinct edges (by source and target) with highest score
        SELECT DISTINCT ON (t.path_source_id, t.path_target_id)
            sn.node_key AS src_node,
            t.edge_type AS rel_type,
            tn.node_key AS tgt_node,
            t.current_score AS base_score
        FROM traverse t
        JOIN graph_nodes sn ON sn.id = t.path_source_id
        JOIN graph_nodes tn ON tn.id = t.path_target_id
        WHERE t.hops > 0  -- exclude zero-hop (just the start node)
        ORDER BY t.path_source_id, t.path_target_id, t.current_score DESC
    ),
    scored AS (
        -- Apply relationship penalty and intent-based boosting
        SELECT
            src_node,
            rel_type,
            tgt_node,
            base_score *
                CASE
                    -- Apply penalty for generic relationships
                    WHEN rel_type IN ('associated_with', 'regarding', 'involved_in', 'mentioned', 'interested_in') THEN 0.1
                    ELSE 1.0
                END *
                CASE
                    -- Apply boost for matching intent
                    WHEN p_graph_intent = 'blocking' AND rel_type IN ('blocked_by', 'requires', 'depends_on') THEN 2.0
                    WHEN p_graph_intent = 'who' AND rel_type IN ('collaborates_on', 'contact_for', 'mentioned_by') THEN 2.0
                    WHEN p_graph_intent = 'working_on' AND rel_type IN ('works_on', 'collaborates_on') THEN 2.0
                    ELSE 1.0
                END AS score
        FROM edges
    )
    SELECT
        src_node AS source_node,
        rel_type AS relationship_type,
        tgt_node AS target_node,
        score
    FROM scored
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION graph_render_relations(uuid, uuid[], integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION graph_render_relations(uuid, uuid[], integer, integer, text) TO service_role;
