#!/usr/bin/env python3
"""
Consolidated graph evaluation framework — replaces evaluate_graph.py,
evaluate_edges.py, evaluate_edges2.py, evaluate_light.py,
evaluate_with_limit.py.

Three evaluation layers:

  1. BENCHMARK MODE (--mode benchmark, default)
     Uses the curated production dataset (graph_eval_production.json) and runs
     the in-memory algorithm. Pure algorithm regression — no database needed.
     Reports recall@k, MRR, nDCG@10, intent-specific accuracy, and per-case
     diagnostics.

  2. SQL VALIDATION MODE (--mode sql)
     Calls the actual graph_render_relations RPC against the linked Supabase
     project using random edge/node samples. Validates that the SQL RPC
     produces expected results. Requires `supabase db query --linked`.

  3. END-TO-END MODE (--mode e2e)
     Exercises the full retrieve-context pipeline via the Supabase client.
     See evaluate_e2e.py for the dedicated harness.

Usage:
    # Benchmark against the production dataset (default)
    python evaluate_graph.py

    # Benchmark with a custom dataset
    python evaluate_graph.py --dataset path/to/dataset.json

    # SQL validation: random edge sampling
    python evaluate_graph.py --mode sql --sample-size 50 --eval-type edge

    # SQL validation: random node traversal
    python evaluate_graph.py --mode sql --sample-size 30 --eval-type graph

    # SQL validation with rate limiting and custom RPC limit
    python evaluate_graph.py --mode sql --sample-size 20 --delay 1 --rpc-limit 20

    # Output metrics as JSON for tooling
    python evaluate_graph.py --output metrics.json
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

# ---- Constants (mirrors graph_render_relations RPC) -------------------------

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


# ---- Metrics ----------------------------------------------------------------

def recall_at_k(ranked, relevant, k):
    """Fraction of relevant items in top-k of ranked list."""
    if not relevant:
        return 1.0  # empty ground truth = vacuously satisfied
    top_k = set(ranked[:k])
    found = sum(1 for r in relevant if r in top_k)
    return found / len(relevant)


def mrr(ranked, relevant):
    """Mean reciprocal rank of first relevant item."""
    if not relevant:
        return 1.0
    for i, item in enumerate(ranked, start=1):
        if item in relevant:
            return 1.0 / i
    return 0.0


def ndcg_at_k(ranked, relevant, k):
    """Normalized discounted cumulative gain at k (binary relevance)."""
    if not relevant:
        return 1.0
    dcg = 0.0
    for i, item in enumerate(ranked[:k], start=1):
        rel = 1.0 if item in relevant else 0.0
        if i == 1:
            dcg += rel
        else:
            dcg += rel / math.log2(i)
    # Ideal DCG: first min(|relevant|, k) items are fully relevant (rel=1)
    n_rel = min(len(relevant), k)
    if n_rel == 0:
        return 0.0
    idcg = 1.0  # rank 1
    for j in range(2, n_rel + 1):
        idcg += 1.0 / math.log2(j)
    return dcg / idcg if idcg > 0 else 0.0


# ---- In-memory graph engine (mirrors Deno GraphEvalEngine) ------------------

class GraphEngine:
    """Pure in-memory graph traversal engine. No database required."""

    def __init__(self, graph_data):
        self.nodes = {n["key"]: n for n in graph_data["nodes"]}
        self.edges = graph_data["edges"]
        # Build adjacency index
        self.outgoing = {}
        for e in self.edges:
            self.outgoing.setdefault(e["source"], []).append(e)

    def outgoing_edges(self, node_key):
        """All non-generic outgoing edges from a node."""
        edges = self.outgoing.get(node_key, [])
        return [e for e in edges if e["relationship"] not in GENERIC_RELATIONSHIPS]

    def resolve_start_nodes(self, keys):
        """Resolve keys to nodes, applying quality gate."""
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

    def traverse(self, case):
        """
        Full graph traversal for a single case.
        Returns (results, avg_hops).
        """
        start_nodes = self.resolve_start_nodes(case["start_node_keys"])
        if not start_nodes:
            return [], 0.0

        intent_boost = INTENT_BOOSTS.get(case.get("intent", "general"), {})

        # BFS traversal (mirrors RECURSIVE CTE)
        class TraverseRow:
            __slots__ = ("current_key", "score", "hops", "path_source_key",
                         "path_target_key", "edge_type")

        frontier = []
        all_rows = []

        for node in start_nodes:
            row = TraverseRow()
            row.current_key = node["key"]
            row.score = 1.0
            row.hops = 0
            row.path_source_key = node["key"]
            row.path_target_key = node["key"]
            row.edge_type = None
            frontier.append(row)

        while frontier:
            row = frontier.pop(0)
            edges = self.outgoing_edges(row.current_key)

            for edge in edges:
                target_node = self.nodes.get(edge["target"])
                if not target_node or target_node["quality_score"] < QUALITY_THRESHOLD:
                    continue
                if row.hops >= MAX_HOPS:
                    continue
                # Immediate backtrack prevention
                if edge["target"] == row.path_source_key:
                    continue

                new_row = TraverseRow()
                new_row.current_key = edge["target"]
                new_row.score = row.score * edge["confidence"] * HOP_DECAY
                new_row.hops = row.hops + 1
                new_row.path_source_key = row.current_key
                new_row.path_target_key = edge["target"]
                new_row.edge_type = edge["relationship"]
                frontier.append(new_row)

            if row.hops > 0:
                all_rows.append(row)

        # DISTINCT ON (path_source_key, path_target_key) — keep best score
        pair_best = {}
        for row in all_rows:
            key = f"{row.path_source_key}|{row.path_target_key}"
            if key not in pair_best or row.score > pair_best[key].score:
                pair_best[key] = row

        # Build results
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

        # Sort by score DESC, limit
        results.sort(key=lambda r: -r["score"])
        results = results[:LIMIT]

        # Compute avg hops
        total_hops = sum(r.hops for r in pair_best.values())
        avg_hops = total_hops / len(pair_best) if pair_best else 0.0

        return results, avg_hops

    def count_generic_edges(self, keys):
        """Count generic vs total outgoing edges from start nodes."""
        total = 0
        generic = 0
        seen = set()
        for key in keys:
            node = self.nodes.get(key)
            if not node or node["quality_score"] < QUALITY_THRESHOLD:
                continue
            for e in self.outgoing.get(key, []):
                ek = f"{e['source']}|{e['relationship']}|{e['target']}"
                if ek in seen:
                    continue
                seen.add(ek)
                total += 1
                if e["relationship"] in GENERIC_RELATIONSHIPS:
                    generic += 1
        return total, generic


# ---- Benchmark evaluation ---------------------------------------------------

def run_benchmark(dataset_path, output_path=None):
    """Evaluate the algorithm against a fixed curated dataset."""
    with open(dataset_path) as f:
        dataset = json.load(f)

    engine = GraphEngine(dataset["graph"])
    cases = dataset["cases"]
    total = len(cases)

    print(f"\n{'='*60}")
    print(f"BENCHMARK MODE")
    print(f"Dataset: {dataset['meta']['name']} ({dataset['meta']['description']})")
    print(f"Cases:   {total}")
    print(f"{'='*60}")

    # Per-case metrics
    per_case = []
    case_results = []  # For detailed output

    # Aggregate metrics
    r5_sum = r10_sum = mrr_sum = ndcg_sum = 0.0
    total_edges = generic_edges = 0
    dep_queries = dep_top1 = dep_top5 = 0
    people_queries = people_top1 = people_top5 = 0
    work_queries = work_top1 = work_top5 = 0
    total_hops = 0.0
    hop_count = 0

    for case in cases:
        cid = case["id"]
        results, avg_hops = engine.traverse(case)

        ranked_keys = [
            f"{r['source_node']}|{r['relationship_type']}|{r['target_node']}"
            for r in results
        ]
        expected_keys = {
            f"{r['source']}|{r['relationship']}|{r['target']}"
            for r in case["expected_relations"]
        }

        r5 = recall_at_k(ranked_keys, expected_keys, 5)
        r10 = recall_at_k(ranked_keys, expected_keys, 10)
        mr = mrr(ranked_keys, expected_keys)
        nd = ndcg_at_k(ranked_keys, expected_keys, 10)

        r5_sum += r5
        r10_sum += r10
        mrr_sum += mr
        ndcg_sum += nd

        # Generic edge count
        te, ge = engine.count_generic_edges(case["start_node_keys"])
        total_edges += te
        generic_edges += ge

        # Intent-specific accuracy
        intent = case.get("intent", "general")
        if intent == "blocking":
            dep_queries += 1
            if ranked_keys and ranked_keys[0] in expected_keys:
                dep_top1 += 1
            if any(k in expected_keys for k in ranked_keys[:5]):
                dep_top5 += 1
        elif intent == "who":
            people_queries += 1
            if ranked_keys and ranked_keys[0] in expected_keys:
                people_top1 += 1
            if any(k in expected_keys for k in ranked_keys[:5]):
                people_top5 += 1
        elif intent == "working_on":
            work_queries += 1
            if ranked_keys and ranked_keys[0] in expected_keys:
                work_top1 += 1
            if any(k in expected_keys for k in ranked_keys[:5]):
                work_top5 += 1

        total_hops += avg_hops
        hop_count += 1

        per_case.append({
            "id": cid,
            "query": case["query"],
            "intent": intent,
            "recall@5": round(r5, 3),
            "recall@10": round(r10, 3),
            "mrr": round(mr, 3),
            "ndcg@10": round(nd, 3),
            "n_expected": len(expected_keys),
            "n_results": len(results),
            "avg_hops": round(avg_hops, 2),
        })

        # Build detailed results for display
        result_str = [f"  {r['source_node']} --[{r['relationship_type']}]--> {r['target_node']} ({r['score']:.3f})" for r in results]
        case_results.append({
            "id": cid,
            "query": case["query"],
            "results": result_str,
            "expected": [f"  {r['source']} --[{r['relationship']}]--> {r['target']}" for r in case["expected_relations"]],
            "r5": r5,
        })

    # Compute aggregate metrics
    metrics = {
        "dataset": dataset["meta"]["name"],
        "total_cases": total,
        "recall@5": round(r5_sum / total, 3),
        "recall@10": round(r10_sum / total, 3),
        "mrr": round(mrr_sum / total, 3),
        "ndcg@10": round(ndcg_sum / total, 3),
        "generic_edge_pct": round((generic_edges / total_edges * 100) if total_edges else 0, 1),
        "avg_hops": round(total_hops / hop_count if hop_count else 0, 2),
        "dependency_top1": round(dep_top1 / dep_queries, 3) if dep_queries else 0,
        "dependency_top5": round(dep_top5 / dep_queries, 3) if dep_queries else 0,
        "people_top1": round(people_top1 / people_queries, 3) if people_queries else 0,
        "people_top5": round(people_top5 / people_queries, 3) if people_queries else 0,
        "working_on_top1": round(work_top1 / work_queries, 3) if work_queries else 0,
        "working_on_top5": round(work_top5 / work_queries, 3) if work_queries else 0,
        "intent_breakdown": {
            "blocking": dep_queries,
            "who": people_queries,
            "working_on": work_queries,
            "general": total - dep_queries - people_queries - work_queries,
        },
    }

    # Print summary
    border = "=" * 60
    print(f"\n{border}")
    print("AGGREGATE METRICS")
    print(border)
    print(f"  Recall@5:     {metrics['recall@5']:.3f}")
    print(f"  Recall@10:    {metrics['recall@10']:.3f}")
    print(f"  MRR:          {metrics['mrr']:.3f}")
    print(f"  nDCG@10:      {metrics['ndcg@10']:.3f}")
    print(f"  Generic edge%: {metrics['generic_edge_pct']:.1f}%")
    print(f"  Avg hops:     {metrics['avg_hops']:.2f}")
    print(f"\n  Intent-specific:")
    print(f"    Blocking  Top-1: {metrics['dependency_top1']:.3f}  Top-5: {metrics['dependency_top5']:.3f}  (n={dep_queries})")
    print(f"    Who       Top-1: {metrics['people_top1']:.3f}  Top-5: {metrics['people_top5']:.3f}  (n={people_queries})")
    print(f"    WorkingOn Top-1: {metrics['working_on_top1']:.3f}  Top-5: {metrics['working_on_top5']:.3f}  (n={work_queries})")
    print(f"  Intent distribution: {metrics['intent_breakdown']}")

    # Print per-case diagnostics
    print(f"\n{border}")
    print("PER-CASE DIAGNOSTICS (recall@5 < 0.50)")
    print(border)
    low_recall = [c for c in case_results if c["r5"] < 0.50 and c["expected"]]
    if low_recall:
        for cr in low_recall:
            print(f"\n  [{cr['id']}] \"{cr['query']}\"  recall@5={cr['r5']:.3f}")
            print(f"  Results ({len(cr['results'])}):")
            for r in cr['results']:
                print(f"    {r}")
            print(f"  Expected ({len(cr['expected'])}):")
            for e in cr['expected']:
                print(f"    {e}")
    else:
        print("  (all pass)")

    if output_path:
        with open(output_path, "w") as f:
            json.dump({
                "metrics": metrics,
                "per_case": per_case,
            }, f, indent=2)
        print(f"\nMetrics written to: {output_path}")

    return metrics


# ---- SQL validation mode ----------------------------------------------------

SQL_VALIDATION_WARNING = """
⚠  SQL VALIDATION MODE
   Calls graph_render_relations RPC against the linked Supabase project.
   This validates the actual SQL RPC behavior against production data.
"""


def run_sql(sql, timeout=30):
    """Execute SQL via `supabase db query --linked`."""
    cmd = ["supabase", "db", "query", "--linked", sql]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            print(f"  SQL error: {result.stderr[:200]}", file=sys.stderr)
            return None
        text = result.stdout.strip()
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1:
            print(f"  Could not find JSON in output: {text[:200]}", file=sys.stderr)
            return None
        data = json.loads(text[start:end + 1])
        return data.get("rows", [])
    except subprocess.TimeoutExpired:
        print(f"  SQL timeout after {timeout}s", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  Exception: {e}", file=sys.stderr)
        return None


def run_sql_validation(args):
    """Evaluate the actual SQL RPC against production data."""
    print(SQL_VALIDATION_WARNING)

    if args.eval_type == "edge":
        sql = f"""
        SELECT user_id, source_node_id, target_node_id, relationship_type
        FROM graph_edges
        WHERE user_id IS NOT NULL
        ORDER BY random()
        LIMIT {args.sample_size};
        """
        rows = run_sql(sql, timeout=args.timeout)
        if not rows:
            print("Failed to fetch edges")
            return

        print(f"Fetched {len(rows)} edges for evaluation")

        total = 0
        hit5 = hit10 = hit100 = 0
        rr_sum = ndcg_sum = 0.0
        generic_in_top5 = 0
        dep_correct_first = 0
        dep_queries = 0

        for idx, r in enumerate(rows):
            if args.delay > 0 and idx > 0:
                time.sleep(args.delay)

            user_id = r["user_id"]
            src = r["source_node_id"]
            tgt = r["target_node_id"]
            expected_type = r["relationship_type"]
            total += 1

            # General intent query
            sql_gen = f"""
            SELECT source_node, relationship_type, target_node, score
            FROM graph_render_relations(
                '{user_id}'::uuid,
                ARRAY['{src}'::uuid],
                {MAX_HOPS}, {args.rpc_limit}, 'general'
            )
            ORDER BY score DESC;
            """
            rows_gen = run_sql(sql_gen, timeout=args.timeout)
            if rows_gen is None:
                continue

            retrieved = [(g["relationship_type"], g["target_node"], g["score"]) for g in rows_gen]

            # Find exact match
            found = False
            rank = None
            for i, (rt, tn, _) in enumerate(retrieved, start=1):
                if tn == tgt and rt == expected_type:
                    found = True
                    rank = i
                    break

            if found:
                if rank <= 5:
                    hit5 += 1
                if rank <= 10:
                    hit10 += 1
                if rank <= args.rpc_limit:
                    hit100 += 1
                if rank:
                    rr_sum += 1.0 / rank

            # nDCG@10
            dcg = 0.0
            for i, (rt, tn, _) in enumerate(retrieved[:10], start=1):
                rel = 1.0 if (tn == tgt and rt == expected_type) else 0.0
                if i == 1:
                    dcg += rel
                else:
                    dcg += rel / math.log2(i)
            idcg = 1.0
            ndcg_sum += dcg / idcg

            # Generic ratio in top 5
            top5_types = [rt for (rt, _, _) in retrieved[:5]]
            generic_in_top5 += sum(1 for t in top5_types if t in GENERIC_RELATIONSHIPS)

            # Dependency intent
            sql_dep = f"""
            SELECT relationship_type
            FROM graph_render_relations(
                '{user_id}'::uuid,
                ARRAY['{src}'::uuid],
                {MAX_HOPS}, 10, 'dependency'
            )
            ORDER BY score DESC
            LIMIT 1;
            """
            row_dep = run_sql(sql_dep, timeout=args.timeout)
            if row_dep and len(row_dep) > 0:
                dep_queries += 1
                if row_dep[0]["relationship_type"] in {"blocked_by", "requires", "depends_on"}:
                    dep_correct_first += 1

        if total == 0:
            print("No valid queries")
            return

        print(f"\n{'='*60}")
        print(f"SQL VALIDATION RESULTS (edge sampling, n={total})")
        print(f"{'='*60}")
        print(f"  Recall@5:              {hit5/total:.3f}")
        print(f"  Recall@10:             {hit10/total:.3f}")
        print(f"  Recall@{args.rpc_limit}:          {hit100/total:.3f}")
        print(f"  MRR:                   {rr_sum/total:.3f}")
        print(f"  nDCG@10:               {ndcg_sum/total:.3f}")
        print(f"  Generic in top 5:      {generic_in_top5/(total*5):.3f}")
        print(f"  Dependency Top-1:      {dep_correct_first/dep_queries:.3f}" if dep_queries else "  Dependency Top-1:      N/A")

    else:
        # Node-level graph sampling (like original evaluate_graph.py)
        sql = f"""
        SELECT DISTINCT id, user_id, node_key
        FROM graph_nodes
        WHERE node_quality_score >= 2
        ORDER BY random()
        LIMIT {args.sample_size};
        """
        rows = run_sql(sql, timeout=args.timeout)
        if not rows:
            print("Failed to fetch nodes")
            return

        print(f"Fetched {len(rows)} nodes for evaluation")

        total = 0
        hit5 = hit10 = 0
        rr_sum = ndcg_sum = 0.0
        generic_in_top5 = 0
        dep_correct_first = 0
        dep_queries = 0

        for idx, node in enumerate(rows):
            if args.delay > 0 and idx > 0:
                time.sleep(args.delay)

            node_id = node["id"]
            user_id = node["user_id"]

            # Get ground truth (direct edges, sorted by confidence)
            sql_gt = f"""
            SELECT relationship_type, confidence
            FROM graph_edges
            WHERE source_node_id = '{node_id}'
            ORDER BY confidence DESC
            LIMIT 10;
            """
            gt_edges = run_sql(sql_gt, timeout=args.timeout)
            if not gt_edges:
                continue

            gt_set = {e["relationship_type"] for e in gt_edges}
            total += 1

            # General intent query
            sql_gen = f"""
            SELECT source_node, relationship_type, target_node, score
            FROM graph_render_relations(
                '{user_id}'::uuid,
                ARRAY['{node_id}'::uuid],
                {MAX_HOPS}, {args.rpc_limit}, 'general'
            )
            ORDER BY score DESC;
            """
            res = run_sql(sql_gen, timeout=args.timeout)
            if res is None:
                continue

            retrieved_types = [r["relationship_type"] for r in res]

            top5 = set(retrieved_types[:5])
            if top5 & gt_set:
                hit5 += 1

            top10 = set(retrieved_types[:10])
            if top10 & gt_set:
                hit10 += 1

            for i, rt in enumerate(retrieved_types, start=1):
                if rt in gt_set:
                    rr_sum += 1.0 / i
                    break

            # nDCG
            dcg = 0.0
            for i, rt in enumerate(retrieved_types[:10], start=1):
                rel = 1.0 if rt in gt_set else 0.0
                if i == 1:
                    dcg += rel
                else:
                    dcg += rel / math.log2(i)
            n_gt = min(len(gt_set), 10)
            idcg = 1.0
            for i in range(2, n_gt + 1):
                idcg += 1.0 / math.log2(i)
            if idcg > 0:
                ndcg_sum += dcg / idcg

            # Generic ratio
            generic_in_top5 += sum(1 for rt in retrieved_types[:5] if rt in GENERIC_RELATIONSHIPS)

            # Dependency intent
            sql_dep = f"""
            SELECT relationship_type
            FROM graph_render_relations(
                '{user_id}'::uuid,
                ARRAY['{node_id}'::uuid],
                {MAX_HOPS}, 10, 'dependency'
            )
            ORDER BY score DESC
            LIMIT 1;
            """
            dep_res = run_sql(sql_dep, timeout=args.timeout)
            if dep_res:
                dep_queries += 1
                if dep_res[0]["relationship_type"] in {"blocked_by", "requires", "depends_on"}:
                    dep_correct_first += 1

        if total == 0:
            print("No valid queries")
            return

        print(f"\n{'='*60}")
        print(f"SQL VALIDATION RESULTS (node sampling, n={total})")
        print(f"{'='*60}")
        print(f"  Recall@5:              {hit5/total:.3f}")
        print(f"  Recall@10:             {hit10/total:.3f}")
        print(f"  MRR:                   {rr_sum/total:.3f}")
        print(f"  nDCG@10:               {ndcg_sum/total:.3f}")
        print(f"  Generic in top 5:      {generic_in_top5/(total*5):.3f}")
        print(f"  Dependency Top-1:      {dep_correct_first/dep_queries:.3f}" if dep_queries else "  Dependency Top-1:      N/A")


# ---- Main -------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Consolidated graph evaluation framework",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Benchmark against production dataset
  python evaluate_graph.py

  # SQL validation: random edge sampling
  python evaluate_graph.py --mode sql --sample-size 50 --eval-type edge

  # Custom dataset
  python evaluate_graph.py --dataset ./my-cases.json

  # Output metrics as JSON
  python evaluate_graph.py --output benchmark-results.json
        """,
    )

    parser.add_argument(
        "--mode", choices=["benchmark", "sql"], default="benchmark",
        help="Evaluation mode (default: benchmark)",
    )
    parser.add_argument(
        "--dataset", type=str, default=None,
        help="Path to benchmark dataset JSON (default: graph_eval_production.json)",
    )
    parser.add_argument(
        "--sample-size", type=int, default=None,
        help="Number of random samples for SQL mode (default: 30 for graph, 50 for edge)",
    )
    parser.add_argument(
        "--eval-type", choices=["graph", "edge"], default="graph",
        help="SQL evaluation type: node-level traversal or edge-level lookup",
    )
    parser.add_argument(
        "--delay", type=float, default=0,
        help="Seconds to delay between SQL queries (rate limiting)",
    )
    parser.add_argument(
        "--rpc-limit", type=int, default=10,
        help="Limit parameter passed to graph_render_relations RPC",
    )
    parser.add_argument(
        "--timeout", type=int, default=30,
        help="SQL query timeout in seconds",
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Path to write metrics JSON output",
    )

    args = parser.parse_args()

    # Set defaults
    if args.sample_size is None:
        args.sample_size = 30 if args.eval_type == "graph" else 50

    if args.dataset is None:
        # Default: look for production benchmark alongside this script
        script_dir = Path(__file__).parent
        default_dataset = (
            script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
            / "graph_eval_production.json"
        )
        if not default_dataset.exists():
            default_dataset = (
                script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
                / "graph-eval-dataset.json"
            )
        args.dataset = str(default_dataset)

    if args.mode == "benchmark":
        run_benchmark(args.dataset, args.output)
    elif args.mode == "sql":
        run_sql_validation(args)


if __name__ == "__main__":
    main()
