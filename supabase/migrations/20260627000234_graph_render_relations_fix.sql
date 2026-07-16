CREATE OR REPLACE FUNCTION public.graph_render_relations(
    p_user_id uuid,
    p_start_node_ids uuid[],
    p_max_hops integer DEFAULT 2,
    p_limit integer DEFAULT 5,
    p_graph_intent text DEFAULT 'general'
)
RETURNS TABLE(
    source_node text,
    relationship_type text,
    target_node text,
    score double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
    RETURN QUERY
    WITH RECURSIVE traverse AS (
        SELECT
            id AS current_node_id,
            1.0::FLOAT AS current_score,
            0 AS hops,
            id AS path_source_id,
            id AS path_target_id,
            NULL::text as edge_type
        FROM graph_nodes
        WHERE user_id = p_user_id AND id = ANY(p_start_node_ids) AND node_quality_score >= 2

        UNION ALL

        SELECT
            e.target_node_id,
            t.current_score * e.confidence * 0.8,
            t.hops + 1,
            t.current_node_id,
            e.target_node_id,
            e.relationship_type
        FROM traverse t
        JOIN graph_edges e ON e.source_node_id = t.current_node_id
        JOIN graph_nodes tn ON e.target_node_id = tn.id AND tn.user_id = p_user_id AND tn.node_quality_score >= 2
        WHERE e.user_id = p_user_id
          AND t.hops < p_max_hops
          AND NOT (e.target_node_id = t.path_source_id)
          AND (e.expires_at IS NULL OR e.expires_at > now())
          AND e.relationship_type NOT IN ('associated_with', 'regarding', 'involved_in', 'mentioned', 'interested_in')
    ),
    edges AS (
        SELECT DISTINCT ON (t.path_source_id, t.path_target_id)
            sn.node_key as source_node,
            t.edge_type as relationship_type,
            tn.node_key as target_node,
            t.current_score as score
        FROM traverse t
        JOIN graph_nodes sn ON sn.id = t.path_source_id
        JOIN graph_nodes tn ON tn.id = t.path_target_id
        WHERE t.hops > 0
        ORDER BY t.path_source_id, t.path_target_id, t.current_score DESC
    ),
    boosted AS (
        SELECT
            e.source_node,
            e.relationship_type,
            e.target_node,
            e.score,
            CASE
                WHEN p_graph_intent = 'blocking' AND e.relationship_type IN ('blocked_by', 'requires', 'depends_on') THEN e.score * 2.0
                WHEN p_graph_intent = 'who' AND e.relationship_type IN ('collaborates_on', 'contact_for', 'mentioned_by') THEN e.score * 2.0
                WHEN p_graph_intent = 'working_on' AND e.relationship_type IN ('works_on', 'collaborates_on') THEN e.score * 2.0
                ELSE e.score
            END AS boosted_score
        FROM edges e
    )
    SELECT b.source_node, b.relationship_type, b.target_node, b.boosted_score as score
    FROM boosted b
    ORDER BY b.boosted_score DESC
    LIMIT p_limit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.graph_render_relations(uuid, uuid[], integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.graph_render_relations(uuid, uuid[], integer, integer, text) TO service_role;
