#!/usr/bin/env python3
"""
Automated failure analysis for the graph evaluation benchmark.

For every case where expected relations are missing from the top-K results,
classify the failure into one or more categories:

  Failure Type              Meaning
  ─────────────────────────────────────────────────────────────────────
  LIMIT reached             Expected relation exists in full results but was
                            truncated by the LIMIT parameter (too many other
                            higher-scoring relations).
  Ranking order             All expected relations are present in results but
                            not ranked high enough; another relation scored
                            higher at the cutoff boundary.
  Missing graph edge        The expected relation genuinely doesn't exist in
                            the graph traversal output — the algorithm/schema
                            doesn't produce it.
  Intent boost mismatch     The expected relation's relationship type isn't
                            boosted under this query's intent, causing it to
                            be out-ranked by boosted relations.
  Quality gate              The start node or target node was filtered by the
                            quality_score < 2 gate.
  Generic edge leak         A generic relationship type leaked into results
                            when it should have been filtered out.
  Wrong start node          The start_node_keys don't include the node needed
                            to reach the expected relation.
  Traversal depth exceeded  The expected relation requires > MAX_HOPS (2) hops.
  No outgoing edges         The start node has zero outgoing edges of the
                            required relationship type.

Usage:
    python analyze_failures.py
    python analyze_failures.py --dataset path/to/production.json
"""

import argparse
import json
import math
import sys
from pathlib import Path
from collections import Counter, defaultdict

# ---- Engine (mirrors GraphEvalEngine) ---------------------------------------

HOP_DECAY = 0.8
MAX_HOPS = 2
LIMIT = 5
QUALITY_THRESHOLD = 2

GENERIC_RELATIONSHIPS = {
    "associated_with", "regarding", "involved_in", "mentioned", "interested_in",
}

INTENT_BOOSTS = {
    "blocking": {"blocked_by": 2.0, "requires": 2.0, "depends_on": 2.0},
    "who": {"collaborates_on": 2.0, "contact_for": 2.0, "mentioned_by": 2.0},
    "working_on": {"works_on": 2.0, "collaborates_on": 2.0},
}


class Analyzer:
    """Traverse + classify why expected relations are missed."""

    def __init__(self, graph_data):
        self.nodes = {n["key"]: n for n in graph_data["nodes"]}
        self.edges = graph_data["edges"]
        self.outgoing = {}
        for e in self.edges:
            self.outgoing.setdefault(e["source"], []).append(e)
        # Build reverse edge lookup
        self.incoming = {}
        for e in self.edges:
            self.incoming.setdefault(e["target"], []).append(e)

    def outgoing_edges(self, node_key):
        return [e for e in self.outgoing.get(node_key, [])
                if e["relationship"] not in GENERIC_RELATIONSHIPS]

    def all_outgoing_edges(self, node_key):
        """Return ALL outgoing edges including generic ones."""
        return self.outgoing.get(node_key, [])

    def resolve_start_nodes(self, keys):
        resolved = []
        seen = set()
        for key in keys:
            if key in seen:
                continue
            seen.add(key)
            node = self.nodes.get(key)
            if node and node["quality_score"] >= QUALITY_THRESHOLD:
                resolved.append(node)
        return resolved

    def traverse_full(self, case):
        """
        Full traversal returning ALL distinct results before LIMIT.
        Returns (all_results_before_limit, results_after_limit, avg_hops).
        """
        start_nodes = self.resolve_start_nodes(case["start_node_keys"])
        if not start_nodes:
            return [], [], 0.0

        intent_boost = INTENT_BOOSTS.get(case.get("intent", "general"), {})

        class Row:
            __slots__ = ("current_key", "score", "hops", "path_source_key",
                         "path_target_key", "edge_type")

        frontier = []
        all_rows = []

        for node in start_nodes:
            r = Row()
            r.current_key = node["key"]
            r.score = 1.0
            r.hops = 0
            r.path_source_key = node["key"]
            r.path_target_key = node["key"]
            r.edge_type = None
            frontier.append(r)

        while frontier:
            row = frontier.pop(0)
            edges = self.outgoing_edges(row.current_key)

            for edge in edges:
                target_node = self.nodes.get(edge["target"])
                if not target_node or target_node["quality_score"] < QUALITY_THRESHOLD:
                    continue
                if row.hops >= MAX_HOPS:
                    continue
                if edge["target"] == row.path_source_key:
                    continue

                nr = Row()
                nr.current_key = edge["target"]
                nr.score = row.score * edge["confidence"] * HOP_DECAY
                nr.hops = row.hops + 1
                nr.path_source_key = row.current_key
                nr.path_target_key = edge["target"]
                nr.edge_type = edge["relationship"]
                frontier.append(nr)

            if row.hops > 0:
                all_rows.append(row)

        # Dedup by pair, keep best score
        pair_best = {}
        for row in all_rows:
            key = f"{row.path_source_key}|{row.path_target_key}"
            if key not in pair_best or row.score > pair_best[key].score:
                pair_best[key] = row

        results = []
        for row in pair_best.values():
            results.append({
                "source_node": row.path_source_key,
                "relationship_type": row.edge_type,
                "target_node": row.path_target_key,
                "score": row.score,
            })

        # Apply intent boost
        for r in results:
            boost = intent_boost.get(r["relationship_type"], 1.0)
            r["score"] = r["score"] * boost

        # Sort by score DESC — FULL results before LIMIT
        full_results = sorted(results, key=lambda r: -r["score"])
        limited = full_results[:LIMIT]

        total_hops = sum(r.hops for r in pair_best.values())
        avg_hops = total_hops / len(pair_best) if pair_best else 0.0

        return full_results, limited, avg_hops


def classify_failures(case, full_results, limited_results):
    """
    For a single case, classify why expected relations are missing from the
    limited (top-5) results. Returns a list of failure dicts.
    """
    failures = []

    expected_set = {
        (r["source"], r["relationship"], r["target"])
        for r in case["expected_relations"]
    }
    if not expected_set:
        return []  # Nothing expected, nothing to fail on

    limited_set = {
        (r["source_node"], r["relationship_type"], r["target_node"])
        for r in limited_results
    }
    full_set = {
        (r["source_node"], r["relationship_type"], r["target_node"])
        for r in full_results
    }

    # Find expected relations that didn't make it into limited results
    missing_from_limited = expected_set - limited_set

    for rel in missing_from_limited:
        src, rel_type, tgt = rel
        reasons = []

        # --- Check: Is the graph edge actually present in the dataset? ---
        edge_exists = any(
            e["source"] == src and e["target"] == tgt and e["relationship"] == rel_type
            for e in analyzer.edges
        )
        if not edge_exists:
            # Could be a reverse-direction edge. Check if edge exists in opposite direction
            rev_edge_exists = any(
                e["source"] == tgt and e["target"] == src and e["relationship"] == rel_type
                for e in analyzer.edges
            )
            if rev_edge_exists:
                reasons.append("reverse_direction_only")
            else:
                reasons.append("missing_graph_edge")
            failures.append({
                "relation": f"{src} --[{rel_type}]--> {tgt}",
                "reasons": reasons,
            })
            continue

        # --- Check: Does the source node pass quality gate? ---
        src_node = analyzer.nodes.get(src)
        if not src_node or src_node["quality_score"] < QUALITY_THRESHOLD:
            reasons.append("quality_gate_source")

        # --- Check: Does the target node pass quality gate? ---
        tgt_node = analyzer.nodes.get(tgt)
        if not tgt_node or tgt_node["quality_score"] < QUALITY_THRESHOLD:
            reasons.append("quality_gate_target")

        if "quality_gate_source" in reasons or "quality_gate_target" in reasons:
            failures.append({
                "relation": f"{src} --[{rel_type}]--> {tgt}",
                "reasons": reasons,
            })
            continue

        # --- Check: Is the edge traversable from any start node? ---
        start_keys = case["start_node_keys"]
        reachable = False
        path_hops = None
        for sk in start_keys:
            # Check if src is directly in start_keys (reachable at 0 hops)
            if sk == src:
                reachable = True
                path_hops = 0
                break
            if _bfs_reachable(analyzer.nodes, analyzer.edges, sk, src):
                reachable = True
                break

        if not reachable:
            reasons.append("wrong_start_node")
            failures.append({
                "relation": f"{src} --[{rel_type}]--> {tgt}",
                "reasons": reasons,
            })
            continue

        # --- Check: Is it in the full results but cut by LIMIT? ---
        if rel in full_set:
            # Find its rank in the full results
            rank = None
            for i, r in enumerate(full_results, start=1):
                if (r["source_node"], r["relationship_type"], r["target_node"]) == rel:
                    rank = i
                    break
            if rank > LIMIT:
                reasons.append(f"LIMIT_reached_rank_{rank}")

        # --- Check: Intent boost mismatch ---
        expected_intent = case.get("intent", "general")
        if expected_intent in INTENT_BOOSTS:
            boosts = INTENT_BOOSTS[expected_intent]
            if rel_type not in boosts:
                # This relation type is NOT boosted under this intent
                # Check if there are boosted relations that outranked it
                boosted_scores = [
                    (r["score"], r["relationship_type"])
                    for r in limited_results
                    if r["relationship_type"] in boosts
                ]
                highest_boosted = max(boosted_scores)[0] if boosted_scores else 0
                # Find this relation's unboosted score
                this_score = None
                for r in full_results:
                    if (r["source_node"], r["relationship_type"], r["target_node"]) == rel:
                        this_score = r["score"] / INTENT_BOOSTS[expected_intent].get(rel_type, 1.0)
                        break
                if this_score and highest_boosted > this_score * 0.8:
                    reasons.append(f"intent_boost_mismatch_unboosted_{rel_type}")

        # --- Check: Generic edge leak (if generic slipped through) ---
        if rel_type in GENERIC_RELATIONSHIPS:
            reasons.append("generic_edge_leak")

        # --- Check: Source node has no outgoing edges of this type ---
        src_edges_of_type = [
            e for e in analyzer.outgoing.get(src, [])
            if e["relationship"] == rel_type and e["target"] == tgt
        ]
        if not src_edges_of_type:
            # Check if edge exists in the opposite direction
            reasons.append("no_outgoing_edge_of_type")

        # --- Check: Ranking order issue ---
        if rel in full_set and not any("LIMIT" in r for r in reasons):
            # The relation IS in full results, IS within hop limit, IS boosted
            # But it's still not in top-5. This is a ranking order issue.
            rank = None
            for i, r in enumerate(full_results, start=1):
                if (r["source_node"], r["relationship_type"], r["target_node"]) == rel:
                    rank = i
                    break
            # Check what's ahead of it
            ahead = [r for r in limited_results
                     if r["score"] > full_results[rank-1]["score"]]
            reasons.append(f"ranking_order_position_{rank}")

        if not reasons:
            reasons.append("unknown")

        failures.append({
            "relation": f"{src} --[{rel_type}]--> {tgt}",
            "reasons": reasons,
        })

    return failures


# Static helper methods for reachability checking
def _bfs_reachable(graph_nodes, graph_edges, start_key, target_key, max_depth=3):
    """Simple BFS to check if target is reachable from start."""
    from collections import deque
    visited = {start_key}
    queue = deque([(start_key, 0)])
    while queue:
        current, depth = queue.popleft()
        if current == target_key:
            return True
        if depth >= max_depth:
            continue
        for e in graph_edges:
            if e["source"] == current and e["target"] not in visited:
                if e["relationship"] in GENERIC_RELATIONSHIPS:
                    continue
                tgt = graph_nodes.get(e["target"])
                if tgt and tgt["quality_score"] >= QUALITY_THRESHOLD:
                    visited.add(e["target"])
                    queue.append((e["target"], depth + 1))
    return False


def analyze(args):
    """Run the full failure analysis."""
    with open(args.dataset) as f:
        dataset = json.load(f)

    global analyzer
    analyzer = Analyzer(dataset["graph"])
    cases = dataset["cases"]

    failure_counter = Counter()
    failure_details = defaultdict(list)
    all_cases_analyzed = 0
    failing_cases = 0
    pass_cases = 0

    print(f"{'='*60}")
    print(f"FAILURE ANALYSIS REPORT")
    print(f"{'='*60}")
    print(f"Dataset: {dataset['meta'].get('name', 'unknown')}")
    print(f"Cases:   {len(cases)}")
    print(f"{'='*60}\n")

    for case in cases:
        cid = case["id"]
        full_results, limited_results, avg_hops = analyzer.traverse_full(case)

        expected_set = {
            (r["source"], r["relationship"], r["target"])
            for r in case["expected_relations"]
        }
        if not expected_set:
            pass_cases += 1
            continue

        limited_set = {
            (r["source_node"], r["relationship_type"], r["target_node"])
            for r in limited_results
        }
        missing = expected_set - limited_set

        all_cases_analyzed += 1

        if not missing:
            pass_cases += 1
            continue

        failing_cases += 1
        failures = classify_failures(case, full_results, limited_results)

        for f in failures:
            primary_reason = f["reasons"][0] if f["reasons"] else "unknown"
            failure_counter[primary_reason] += 1
            failure_details[primary_reason].append({
                "case": cid,
                "query": case["query"],
                "relation": f["relation"],
                "all_reasons": f["reasons"],
            })

    # ---- Print summary ----
    print(f"  Cases with expected relations: {all_cases_analyzed}")
    print(f"  Passing (all expected found):    {pass_cases}")
    print(f"  Failing (at least one missing):  {failing_cases}")
    print(f"  Total missing relations:         {sum(failure_counter.values())}")
    print()

    # Print frequency table
    print(f"{'Failure Type':<40} {'Count':>6}")
    print(f"{'-'*40} {'-'*6}")
    for ftype, count in failure_counter.most_common():
        print(f"{ftype:<40} {count:>6}")
    print()

    # Print detailed breakdown per case
    print(f"{'='*60}")
    print("DETAILED BREAKDOWN")
    print(f"{'='*60}")
    for ftype in sorted(failure_details.keys()):
        items = failure_details[ftype]
        print(f"\n--- {ftype} ({len(items)} occurrences) ---")
        # Only show first few examples to keep output manageable
        for item in items[:5]:
            print(f"  [{item['case']}] \"{item['query'][:60]}\"")
            print(f"    Missing: {item['relation']}")
            if len(item['all_reasons']) > 1:
                print(f"    All reasons: {', '.join(item['all_reasons'])}")
        if len(items) > 5:
            print(f"    ... and {len(items) - 5} more")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Failure analysis for graph evaluation benchmark"
    )
    parser.add_argument(
        "--dataset", type=str, default=None,
        help="Path to benchmark dataset JSON"
    )
    args = parser.parse_args()

    if args.dataset is None:
        script_dir = Path(__file__).parent
        prod_dataset = (
            script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
            / "graph_eval_production.json"
        )
        if prod_dataset.exists():
            args.dataset = str(prod_dataset)
        else:
            print("No dataset found. Specify --dataset")
            sys.exit(1)

    analyze(args)
