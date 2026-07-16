// Graph evaluation engine — mirrors the graph_render_relations RPC logic
// exactly. Pure computation, no database required.
//
// This is the SINGLE SOURCE OF TRUTH for graph evaluation. Both the CI test
// suite and the deployment quality-benchmark script import from here.
//
// See: supabase/migrations/047_graph_render_relations.sql

import { recallAtK, mrr, ndcgAtK } from "./metrics.ts";

// ---- Types ----------------------------------------------------------------

export interface GraphNode {
  key: string;
  type: string;
  quality_score: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: string;
  confidence: number;
}

export interface ExpectedRelation {
  source: string;
  relationship: string;
  target: string;
}

export interface GraphEvalCase {
  id: string;
  query: string;
  intent: "general" | "blocking" | "who" | "working_on";
  start_node_keys: string[];
  expected_relations: ExpectedRelation[];
  _explanation?: string;
}

export interface GraphEvalDataset {
  meta: {
    name: string;
    description: string;
    created: string;
    schema_version: number;
  };
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  cases: GraphEvalCase[];
}

export interface TraversalResult {
  source_node: string;
  relationship_type: string;
  target_node: string;
  score: number;
}

export interface GraphEvalMetrics {
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  genericEdgePct: number;
  dependencyTop1: number;
  peopleTop1: number;
  avgLatencyMs: number;
  avgHops: number;
  dependencyTop5: number;
  peopleTop5: number;
}

// ---- Constants (mirrors graph_render_relations RPC) -----------------------

const HOP_DECAY = 0.8;
const MAX_HOPS = 2;
const LIMIT = 5;
const QUALITY_THRESHOLD = 2;

// Edge types filtered out by the RPC (generic relationships)
const GENERIC_RELATIONSHIPS = new Set([
  "associated_with",
  "regarding",
  "involved_in",
  "mentioned",
  "interested_in",
]);

// Intent-based boost mapping (mirrors the CASE expression in the RPC)
const INTENT_BOOSTS: Record<string, Record<string, number>> = {
  blocking: {
    blocked_by: 2.0,
    requires: 2.0,
    depends_on: 2.0,
  },
  who: {
    collaborates_on: 2.0,
    contact_for: 2.0,
    mentioned_by: 2.0,
  },
  working_on: {
    works_on: 2.0,
    collaborates_on: 2.0,
  },
};

// ---- Graph Engine ---------------------------------------------------------

export class GraphEvalEngine {
  private nodes: Map<string, GraphNode>;
  private edges: GraphEdge[];

  constructor(dataset: GraphEvalDataset) {
    this.nodes = new Map();
    for (const n of dataset.graph.nodes) {
      this.nodes.set(n.key, n);
    }
    this.edges = dataset.graph.edges;
  }

  /**
   * Build a lookup: for a given node key, return all outgoing edges
   * that pass the generic-relationship filter.
   */
  private outgoingEdges(nodeKey: string): GraphEdge[] {
    return this.edges.filter(
      (e) =>
        e.source === nodeKey &&
        !GENERIC_RELATIONSHIPS.has(e.relationship)
    );
  }

  /**
   * Resolve start node keys to actual node objects, applying the
   * quality_score >= 2 gate (mirrors the RPC base case).
   */
  private resolveStartNodes(keys: string[]): GraphNode[] {
    const resolved: GraphNode[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const node = this.nodes.get(key);
      if (node && node.quality_score >= QUALITY_THRESHOLD) {
        resolved.push(node);
      }
    }
    return resolved;
  }

  /**
   * Run the full graph_render_relations traversal for a single case.
   * Mirrors the PostgreSQL RPC exactly:
   *   1. Base: select start nodes with quality >= 2
   *   2. Recursive: follow outgoing edges with quality/hop/cycle/expiry/relationship gates
   *   3. Edges: DISTINCT ON (path_source_id, path_target_id)
   *   4. Boost: intent-based score multiplier
   *   5. Order by boosted_score DESC, limit
   */
  traverse(case_: GraphEvalCase): {
    results: TraversalResult[];
    latencyMs: number;
    avgHops: number;
  } {
    const startTime = performance.now();
    const startNodes = this.resolveStartNodes(case_.start_node_keys);
    if (startNodes.length === 0) {
      const latencyMs = performance.now() - startTime;
      return { results: [], latencyMs, avgHops: 0 };
    }

    const intentBoost = INTENT_BOOSTS[case_.intent] ?? {};

    // ---- Step 1 & 2: Recursive traversal ----

    type TraverseRow = {
      currentKey: string;
      score: number;
      hops: number;
      pathSourceKey: string;
      pathTargetKey: string;
      edgeType: string | null;
    };

    const frontier: TraverseRow[] = [];
    const allRows: TraverseRow[] = [];

    // Base case
    for (const node of startNodes) {
      frontier.push({
        currentKey: node.key,
        score: 1.0,
        hops: 0,
        pathSourceKey: node.key,
        pathTargetKey: node.key,
        edgeType: null,
      });
    }

    // BFS-style traversal
    while (frontier.length > 0) {
      const row = frontier.shift()!;
      const edges = this.outgoingEdges(row.currentKey);

      for (const edge of edges) {
        const targetNode = this.nodes.get(edge.target);
        if (!targetNode || targetNode.quality_score < QUALITY_THRESHOLD) continue;
        if (row.hops >= MAX_HOPS) continue;
        if (edge.target === row.pathSourceKey) continue;

        frontier.push({
          currentKey: edge.target,
          score: row.score * edge.confidence * HOP_DECAY,
          hops: row.hops + 1,
          pathSourceKey: row.currentKey,
          pathTargetKey: edge.target,
          edgeType: edge.relationship,
        });
      }

      if (row.hops > 0) {
        allRows.push(row);
      }
    }

    // ---- Step 3: DISTINCT ON (path_source_id, path_target_id) ----
    const pairBest = new Map<string, TraverseRow>();
    for (const row of allRows) {
      const key = `${row.pathSourceKey}|${row.pathTargetKey}`;
      const existing = pairBest.get(key);
      if (!existing || row.score > existing.score) {
        pairBest.set(key, row);
      }
    }

    const edgesResult: TraversalResult[] = [];
    for (const row of pairBest.values()) {
      const sourceNode = this.nodes.get(row.pathSourceKey);
      const targetNode = this.nodes.get(row.pathTargetKey);
      if (!sourceNode || !targetNode) continue;

      edgesResult.push({
        source_node: sourceNode.key,
        relationship_type: row.edgeType!,
        target_node: targetNode.key,
        score: row.score,
      });
    }

    // ---- Step 4: Apply intent-based boost ----
    const boosted = edgesResult.map((r) => {
      const boost = intentBoost[r.relationship_type] ?? 1.0;
      return { ...r, score: r.score * boost };
    });

    // ---- Step 5: Sort by boosted score DESC, limit ----
    boosted.sort((a, b) => b.score - a.score);
    const limited = boosted.slice(0, LIMIT);

    const totalHops = [...pairBest.values()].reduce((s, r) => s + r.hops, 0);
    const avgHops = pairBest.size > 0 ? totalHops / pairBest.size : 0;

    const latencyMs = performance.now() - startTime;
    return { results: limited, latencyMs, avgHops };
  }

  /**
   * Run all test cases and compute aggregate metrics.
   */
  evaluate(cases: GraphEvalCase[]): GraphEvalMetrics {
    let totalR5 = 0, totalR10 = 0, totalMrr = 0, totalNdcg10 = 0;
    let totalGenericEdges = 0, totalEdges = 0;
    let depTop1Correct = 0, depQueries = 0;
    let peopleTop1Correct = 0, peopleQueries = 0;
    let totalLatency = 0;
    let totalHops = 0, hopCounted = 0;
    let dependencyTop5Correct = 0;
    let peopleTop5Correct = 0;

    for (const c of cases) {
      const evalResult = this.traverse(c);
      const rankedKeys = evalResult.results.map(
        (r) => `${r.source_node}|${r.relationship_type}|${r.target_node}`
      );
      const expectedKeys = new Set(
        c.expected_relations.map(
          (r) => `${r.source}|${r.relationship}|${r.target}`
        )
      );

      totalR5 += recallAtK(rankedKeys, expectedKeys, 5);
      totalR10 += recallAtK(rankedKeys, expectedKeys, 10);
      totalMrr += mrr(rankedKeys, expectedKeys);
      totalNdcg10 += ndcgAtK(rankedKeys, expectedKeys, 10);

      const allEdges = this.outgoingEdgesFromAllStartNodes(c.start_node_keys);
      totalEdges += allEdges.length;
      totalGenericEdges += allEdges.filter((e) =>
        GENERIC_RELATIONSHIPS.has(e.relationship)
      ).length;

      if (c.intent === "blocking") {
        depQueries++;
        if (rankedKeys.length > 0 && expectedKeys.has(rankedKeys[0])) depTop1Correct++;
        if (rankedKeys.slice(0, 5).some((k) => expectedKeys.has(k))) dependencyTop5Correct++;
      }

      if (c.intent === "who") {
        peopleQueries++;
        if (rankedKeys.length > 0 && expectedKeys.has(rankedKeys[0])) peopleTop1Correct++;
        if (rankedKeys.slice(0, 5).some((k) => expectedKeys.has(k))) peopleTop5Correct++;
      }

      totalLatency += evalResult.latencyMs;
      totalHops += evalResult.avgHops;
      hopCounted++;
    }

    const N = cases.length;
    const genericEdgePct =
      totalEdges > 0 ? (totalGenericEdges / totalEdges) * 100 : 0;

    return {
      recall5: totalR5 / N,
      recall10: totalR10 / N,
      mrr: totalMrr / N,
      ndcg10: totalNdcg10 / N,
      genericEdgePct,
      dependencyTop1: depQueries > 0 ? depTop1Correct / depQueries : 0,
      peopleTop1: peopleQueries > 0 ? peopleTop1Correct / peopleQueries : 0,
      avgLatencyMs: totalLatency / N,
      avgHops: hopCounted > 0 ? totalHops / hopCounted : 0,
      dependencyTop5: depQueries > 0 ? dependencyTop5Correct / depQueries : 0,
      peopleTop5: peopleQueries > 0 ? peopleTop5Correct / peopleQueries : 0,
    };
  }

  private outgoingEdgesFromAllStartNodes(keys: string[]): GraphEdge[] {
    const startNodes = this.resolveStartNodes(keys);
    const allEdges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const node of startNodes) {
      for (const edge of this.edges) {
        if (edge.source === node.key) {
          const k = `${edge.source}|${edge.relationship}|${edge.target}`;
          if (!seen.has(k)) {
            seen.add(k);
            allEdges.push(edge);
          }
        }
      }
    }
    return allEdges;
  }
}
