-- Migration 042: Knowledge Graph
-- Phase 034A Implementation

-- graph_nodes
CREATE TABLE graph_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    node_key TEXT NOT NULL,
    node_type TEXT NOT NULL, -- e.g., 'person', 'project', 'company'
    centroid vector(1536), -- for hybrid_search_nodes
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(user_id, node_key)
);

CREATE INDEX idx_graph_nodes_user_id ON graph_nodes(user_id);
-- No ivfflat index as per user request (wait until > 50k nodes)

-- graph_node_members
CREATE TABLE graph_node_members (
    node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    memory_id UUID NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    PRIMARY KEY(node_id, memory_id)
);

-- graph_edges
CREATE TABLE graph_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source_node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    confidence FLOAT NOT NULL,
    last_evidence_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(source_node_id, target_node_id, relationship_type)
);

CREATE INDEX idx_graph_edges_source ON graph_edges(source_node_id);
CREATE INDEX idx_graph_edges_target ON graph_edges(target_node_id);
CREATE INDEX idx_graph_edges_user ON graph_edges(user_id);

-- edge_evidence (provenance)
CREATE TABLE edge_evidence (
    edge_id UUID NOT NULL REFERENCES graph_edges(id) ON DELETE CASCADE,
    memory_id UUID NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL, -- e.g., 'direct_statement', 'rule_extraction', 'inferred'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    PRIMARY KEY(edge_id, memory_id)
);

-- graph_build_audit
CREATE TABLE graph_build_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    memory_id UUID NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    status TEXT NOT NULL, -- 'success', 'error'
    error_details TEXT,
    nodes_created INT DEFAULT 0,
    edges_created INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- graph_quality_audit
CREATE TABLE graph_quality_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    node_count INT NOT NULL,
    edge_count INT NOT NULL,
    avg_confidence FLOAT NOT NULL,
    inferred_edges INT NOT NULL,
    rule_edges INT NOT NULL,
    expired_edges INT NOT NULL,
    cycles_detected INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- RLS Policies
ALTER TABLE graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_node_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_build_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_quality_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own graph_nodes" ON graph_nodes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can read own graph_edges" ON graph_edges FOR SELECT USING (auth.uid() = user_id);
-- Other write policies are effectively service_role only.

-- RPC: resolve_nodes_for_memories
CREATE OR REPLACE FUNCTION resolve_nodes_for_memories(
    p_user_id UUID,
    p_memory_ids UUID[]
) RETURNS TABLE (
    node_id UUID,
    node_key TEXT,
    node_type TEXT
) LANGUAGE sql SECURITY DEFINER AS $$
    SELECT DISTINCT n.id, n.node_key, n.node_type
    FROM graph_nodes n
    JOIN graph_node_members m ON n.id = m.node_id
    WHERE n.user_id = p_user_id
      AND m.memory_id = ANY(p_memory_ids);
$$;

-- RPC: invalidate_edges_for_memories
-- Soft-expiry / garbage collection trigger logic
CREATE OR REPLACE FUNCTION invalidate_edges_for_memories(
    p_user_id UUID,
    p_memory_ids UUID[]
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    -- Remove the evidence
    DELETE FROM edge_evidence
    WHERE memory_id = ANY(p_memory_ids);
    
    -- Cleanup edges that no longer have any evidence
    DELETE FROM graph_edges ge
    WHERE ge.user_id = p_user_id 
      AND NOT EXISTS (
        SELECT 1 FROM edge_evidence ee WHERE ee.edge_id = ge.id
      );

    -- Cleanup nodes that no longer have edges or members? 
    -- For now, just node members
    DELETE FROM graph_node_members
    WHERE memory_id = ANY(p_memory_ids);
    
    -- Cleanup orphaned nodes
    DELETE FROM graph_nodes gn
    WHERE gn.user_id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM graph_node_members m WHERE m.node_id = gn.id)
      AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.source_node_id = gn.id OR e.target_node_id = gn.id);
END;
$$;

-- RPC: hybrid_search_nodes
CREATE OR REPLACE FUNCTION hybrid_search_nodes(
    p_user_id UUID,
    p_query_embedding vector(1536),
    p_match_count INT
) RETURNS TABLE (
    node_id UUID,
    node_key TEXT,
    node_type TEXT,
    similarity FLOAT
) LANGUAGE sql SECURITY DEFINER AS $$
    SELECT id, node_key, node_type, 1 - (centroid <=> p_query_embedding) AS similarity
    FROM graph_nodes
    WHERE user_id = p_user_id AND centroid IS NOT NULL
    ORDER BY centroid <=> p_query_embedding
    LIMIT p_match_count;
$$;

-- RPC: graph_traverse_typed
CREATE OR REPLACE FUNCTION graph_traverse_typed(
    p_user_id UUID,
    p_start_node_ids UUID[],
    p_max_hops INT,
    p_hop_decay FLOAT DEFAULT 0.8
) RETURNS TABLE (
    path UUID[],
    end_node_id UUID,
    end_node_key TEXT,
    end_node_type TEXT,
    total_score FLOAT,
    hop_count INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE traverse AS (
        -- Base case: the seed nodes
        SELECT 
            ARRAY[id] AS path_nodes,
            id AS current_node_id,
            1.0::FLOAT AS current_score,
            0 AS hops
        FROM graph_nodes
        WHERE user_id = p_user_id 
          AND id = ANY(p_start_node_ids)
        
        UNION ALL
        
        -- Recursive step
        SELECT 
            t.path_nodes || e.target_node_id,
            e.target_node_id,
            t.current_score * e.confidence * p_hop_decay,
            t.hops + 1
        FROM traverse t
        JOIN graph_edges e ON e.source_node_id = t.current_node_id
        WHERE e.user_id = p_user_id
          AND t.hops < p_max_hops
          AND NOT (e.target_node_id = ANY(t.path_nodes)) -- Prevent cycles
          AND (e.expires_at IS NULL OR e.expires_at > now()) -- Check expiry
    )
    SELECT 
        t.path_nodes,
        t.current_node_id,
        n.node_key,
        n.node_type,
        t.current_score,
        t.hops
    FROM traverse t
    JOIN graph_nodes n ON n.id = t.current_node_id
    WHERE t.hops > 0 -- Exclude the seed nodes themselves if we only want paths
    ORDER BY t.current_score DESC;
END;
$$;
