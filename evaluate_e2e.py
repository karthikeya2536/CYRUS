#!/usr/bin/env python3
"""
End-to-end retrieval evaluation harness.

Exercises the full retrieve-context pipeline:
    Natural language
        → Intent classification
        → Start node resolution
        → graph_render_relations
        → Ranker
        → Context assembly
        → Response

Measures per-stage metrics:
  - Intent classification accuracy
  - Graph relations recall
  - Context assembly completeness
  - End-to-end latency

Usage:
    # Evaluate against a local Supabase instance
    python evaluate_e2e.py --local --token <user-bearer-token>

    # Evaluate against the remote (deployed) function
    python evaluate_e2e.py --remote --token <user-bearer-token>

    # Use a custom dataset with expected facts
    python evaluate_e2e.py --local --token <token> --dataset my-e2e-cases.json

    # Output detailed results as JSON
    python evaluate_e2e.py --local --token <token> --output e2e-results.json
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


# ---- Metrics (shared with evaluate_graph.py) --------------------------------

def recall_at_k(ranked, relevant, k):
    if not relevant:
        return 1.0
    top_k = set(ranked[:k])
    return sum(1 for r in relevant if r in top_k) / len(relevant)


def mrr(ranked, relevant):
    if not relevant:
        return 1.0
    for i, item in enumerate(ranked, start=1):
        if item in relevant:
            return 1.0 / i
    return 0.0


def ndcg_at_k(ranked, relevant, k):
    if not relevant:
        return 1.0
    dcg = 0.0
    for i, item in enumerate(ranked[:k], start=1):
        rel = 1.0 if item in relevant else 0.0
        if i == 1:
            dcg += rel
        else:
            dcg += rel / math.log2(i)
    n_rel = min(len(relevant), k)
    idcg = 1.0
    for i in range(2, n_rel + 1):
        idcg += 1.0 / math.log2(i)
    return dcg / idcg if idcg > 0 else 0.0


# ---- E2E Evaluation ---------------------------------------------------------

def call_retrieve_context(endpoint, token, query, timeout=30):
    """Call the retrieve-context edge function and return the response."""
    url = f"{endpoint}/functions/v1/retrieve-context"
    payload = json.dumps({"query": query}).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data, None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8") if e.fp else ""
        return None, f"HTTP {e.code}: {body[:500]}"
    except urllib.error.URLError as e:
        return None, f"URL error: {e.reason}"
    except Exception as e:
        return None, str(e)


def evaluate_pipeline_response(response, case, verbose=False):
    """
    Evaluate a single retrieve-context response against expected results.

    Returns a dict of per-stage metrics.
    """
    metrics = {}

    # --- Stage 1: Intent classification ---
    parsed = response.get("parsed", {})
    detected_intent = parsed.get("intent", "unknown")
    expected_intent = case.get("intent", "general")
    intent_correct = detected_intent == expected_intent
    metrics["intent_correct"] = intent_correct
    metrics["detected_intent"] = detected_intent
    metrics["expected_intent"] = expected_intent

    # --- Stage 2: Entities extracted ---
    detected_entities = set(parsed.get("entities", []))
    metrics["entity_count"] = len(detected_entities)

    # --- Stage 3: Graph relations ---
    context = response.get("context", [])
    graph_relations = [c for c in context if c.get("source") == "graph"]
    graph_relation_count = len(graph_relations)

    # Check expected relations against graph relations in context
    expected_relations = case.get("expected_relations", [])
    expected_rel_keys = {
        f"{r['source']}|{r['relationship']}|{r['target']}"
        for r in expected_relations
    }
    actual_rel_keys = {
        c["text"].replace("[Relation] ", "")
        for c in graph_relations
    }

    # Parse the relation text format: "source relationship target."
    actual_rel_parsed = set()
    for text in actual_rel_keys:
        parts = text.rstrip(".").split()
        if len(parts) >= 3:
            # Format: [Relation] src rel tgt.
            src = parts[0]
            rel = parts[1]
            tgt = parts[2]
            actual_rel_parsed.add(f"{src}|{rel}|{tgt}")

    graph_recall5 = recall_at_k(list(actual_rel_parsed), expected_rel_keys, 5)
    graph_recall_all = recall_at_k(list(actual_rel_parsed), expected_rel_keys, 100)
    graph_mrr = mrr(list(actual_rel_parsed), expected_rel_keys)

    metrics["graph_relations_count"] = graph_relation_count
    metrics["graph_expected_count"] = len(expected_relations)
    metrics["graph_recall@5"] = round(graph_recall5, 3)
    metrics["graph_recall"] = round(graph_recall_all, 3)
    metrics["graph_mrr"] = round(graph_mrr, 3)

    # --- Stage 4: Context assembly completeness ---
    metadata = response.get("metadata", {})
    total_retrieved = metadata.get("total_retrieved", 0)
    above_threshold = metadata.get("above_threshold", 0)
    included = metadata.get("included", 0)
    ctx_text = " ".join(c.get("text", "") for c in context)

    # Check for expected facts (strings that should appear)
    expected_facts = case.get("expected_facts", [])
    facts_found = 0
    for fact in expected_facts:
        if fact.lower() in ctx_text.lower():
            facts_found += 1
    fact_recall = facts_found / len(expected_facts) if expected_facts else 1.0

    metrics["total_retrieved"] = total_retrieved
    metrics["above_threshold"] = above_threshold
    metrics["context_included"] = included
    metrics["expected_facts_count"] = len(expected_facts)
    metrics["facts_found"] = facts_found
    metrics["fact_recall"] = round(fact_recall, 3)

    # --- Stage 5: Latency ---
    metrics["latency_ms"] = response.get("latencyMs", 0)

    # --- Overall: Pipeline success ---
    pipeline_success = (
        intent_correct and
        (len(expected_relations) == 0 or graph_recall_all > 0) and
        fact_recall >= 0.5 if expected_facts else True
    )
    metrics["pipeline_success"] = pipeline_success

    return metrics


def run_e2e_evaluation(args):
    """Run the full end-to-end evaluation."""
    # Load dataset
    with open(args.dataset) as f:
        dataset = json.load(f)

    cases = dataset["cases"]
    total = len(cases)
    endpoint = args.local_endpoint if args.local else args.remote_endpoint
    token = args.token

    print(f"\n{'='*60}")
    print(f"END-TO-END RETRIEVAL EVALUATION")
    print(f"{'='*60}")
    print(f"Endpoint: {endpoint}")
    print(f"Dataset:  {dataset['meta'].get('name', args.dataset)}")
    print(f"Cases:    {total}")
    print(f"Delay:    {args.delay}s between calls")
    print()

    if not token:
        print("ERROR: No auth token provided. Use --token <bearer-token>")
        print("  Tip: run `! supabase functions serve` locally, then")
        print("  get a valid JWT from your local Supabase auth.")
        sys.exit(1)

    # Per-case results
    per_case = []

    # Aggregate metrics
    pipeline_success_count = 0
    intent_correct_count = 0
    graph_mrr_sum = 0.0
    graph_recall5_sum = 0.0
    graph_recall_sum = 0.0
    fact_recall_sum = 0.0
    total_graph_expected = 0
    total_graph_relations = 0
    total_facts_expected = 0
    total_facts_found = 0
    latencies = []
    errors = 0

    for idx, case in enumerate(cases):
        cid = case["id"]
        query = case["query"]

        if verbose:
            print(f"\n  [{idx+1}/{total}] {cid}: \"{query}\"")

        # Call the edge function
        response, error = call_retrieve_context(
            endpoint, token, query, timeout=args.timeout
        )

        if error or response is None:
            print(f"  ✗ [{cid}] ERROR: {error}")
            errors += 1
            per_case.append({
                "id": cid,
                "query": query,
                "error": error,
                "pipeline_success": False,
            })
            time.sleep(args.delay)
            continue

        # Evaluate the response
        m = evaluate_pipeline_response(response, case, verbose=args.verbose)

        per_case.append({
            "id": cid,
            "query": query,
            "intent": m["detected_intent"],
            "intent_correct": m["intent_correct"],
            "expected_intent": m["expected_intent"],
            "graph_recall@5": m["graph_recall@5"],
            "graph_recall": m["graph_recall"],
            "graph_mrr": m["graph_mrr"],
            "graph_relations": m["graph_relations_count"],
            "graph_expected": m["graph_expected_count"],
            "fact_recall": m["fact_recall"],
            "facts_found": m["facts_found"],
            "facts_expected": m["expected_facts_count"],
            "latency_ms": m["latency_ms"],
            "pipeline_success": m["pipeline_success"],
        })

        if m["pipeline_success"]:
            pipeline_success_count += 1
        if m["intent_correct"]:
            intent_correct_count += 1
        graph_mrr_sum += m["graph_mrr"]
        graph_recall5_sum += m["graph_recall@5"]
        graph_recall_sum += m["graph_recall"]
        fact_recall_sum += m["fact_recall"]
        total_graph_expected += m["graph_expected_count"]
        total_graph_relations += m["graph_relations_count"]
        total_facts_expected += m["expected_facts_count"]
        total_facts_found += m["facts_found"]
        latencies.append(m["latency_ms"])

        if args.verbose:
            status = "✓" if m["pipeline_success"] else "✗"
            print(f"    Intent: {m['detected_intent']} (expected: {m['expected_intent']}) {'✓' if m['intent_correct'] else '✗'}")
            print(f"    Graph relations: {m['graph_relations_count']}/{m['graph_expected_count']}, recall@5={m['graph_recall@5']:.3f}")
            if m["expected_facts_count"] > 0:
                print(f"    Facts: {m['facts_found']}/{m['expected_facts_count']}")
            print(f"    Latency: {m['latency_ms']}ms  Status: {status}")

        time.sleep(args.delay)

    # Compute aggregate metrics
    valid = total - errors
    avg_metrics = {
        "endpoint": endpoint,
        "dataset": dataset["meta"].get("name", args.dataset),
        "total_cases": total,
        "errors": errors,
        "valid_cases": valid,
    }

    if valid > 0:
        avg_metrics.update({
            "pipeline_success_rate": round(pipeline_success_count / valid, 3),
            "intent_accuracy": round(intent_correct_count / valid, 3),
            "avg_graph_recall@5": round(graph_recall5_sum / valid, 3),
            "avg_graph_recall": round(graph_recall_sum / valid, 3),
            "avg_graph_mrr": round(graph_mrr_sum / valid, 3),
            "avg_fact_recall": round(fact_recall_sum / valid, 3),
            "total_graph_expected": total_graph_expected,
            "total_graph_returned": total_graph_relations,
            "total_facts_expected": total_facts_expected,
            "total_facts_found": total_facts_found,
            "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else 0,
            "min_latency_ms": min(latencies) if latencies else 0,
            "max_latency_ms": max(latencies) if latencies else 0,
            "p50_latency_ms": sorted(latencies)[len(latencies) // 2] if latencies else 0,
            "p95_latency_ms": sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0,
            "p99_latency_ms": sorted(latencies)[int(len(latencies) * 0.99)] if latencies else 0,
        })

    # Print summary
    print(f"\n{'='*60}")
    print(f"AGGREGATE E2E METRICS")
    print(f"{'='*60}")
    print(f"  Pipeline success rate:   {avg_metrics.get('pipeline_success_rate', 'N/A'):.1%}")
    print(f"  Intent accuracy:         {avg_metrics.get('intent_accuracy', 'N/A'):.1%}")
    print(f"  Avg graph recall@5:      {avg_metrics.get('avg_graph_recall@5', 'N/A'):.3f}")
    print(f"  Avg graph recall:        {avg_metrics.get('avg_graph_recall', 'N/A'):.3f}")
    print(f"  Avg graph MRR:           {avg_metrics.get('avg_graph_mrr', 'N/A'):.3f}")
    print(f"  Avg fact recall:         {avg_metrics.get('avg_fact_recall', 'N/A'):.3f}")
    print(f"  Graph relations:         {avg_metrics.get('total_graph_returned', 0)}/{avg_metrics.get('total_graph_expected', 0)}")
    print(f"  Facts found:             {avg_metrics.get('total_facts_found', 0)}/{avg_metrics.get('total_facts_expected', 0)}")
    print(f"  Avg latency:             {avg_metrics.get('avg_latency_ms', 'N/A')}ms")
    print(f"  P50/P95/P99 latency:     {avg_metrics.get('p50_latency_ms', 'N/A')}/{avg_metrics.get('p95_latency_ms', 'N/A')}/{avg_metrics.get('p99_latency_ms', 'N/A')}ms")
    print(f"  Errors:                  {errors}/{total}")

    if args.output:
        output = {
            "metrics": avg_metrics,
            "per_case": per_case,
        }
        with open(args.output, "w") as f:
            json.dump(output, f, indent=2)
        print(f"\nDetailed results written to: {args.output}")

    return avg_metrics


def generate_e2e_dataset(production_dataset, output_path):
    """
    Generate an E2E dataset from a production benchmark by adding expected_facts.

    Reads the production benchmark and auto-generates expected facts for each
    case based on the expected_relations.
    """
    with open(production_dataset) as f:
        dataset = json.load(f)

    for case in dataset["cases"]:
        # Auto-generate facts from expected relations
        facts = []
        for rel in case["expected_relations"]:
            facts.append(f"{rel['source']} {rel['relationship']} {rel['target']}")
        case["expected_facts"] = facts

    dataset["meta"]["schema_version"] = 3
    dataset["meta"]["description"] += " (E2E extended: includes expected_facts)"

    # Write extended dataset
    with open(output_path, "w") as f:
        json.dump(dataset, f, indent=2)

    print(f"Generated E2E dataset: {output_path}")
    print(f"  Cases: {len(dataset['cases'])}")
    print(f"  With expected_facts: {sum(1 for c in dataset['cases'] if c.get('expected_facts'))}")
    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="End-to-end retrieval evaluation harness",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Evaluate against local Supabase
  python evaluate_e2e.py --local --token <jwt-token>

  # Evaluate against deployed function
  python evaluate_e2e.py --remote --token <jwt-token>

  # Generate E2E dataset from production benchmark
  python evaluate_e2e.py --generate-e2e-dataset

  # Use custom E2E dataset
  python evaluate_e2e.py --local --token <token> --dataset e2e-dataset.json

  # Get a token:
  #   ! supabase auth login  (then use the access_token from the response)
        """,
    )

    # Endpoint mode
    endpoint_group = parser.add_mutually_exclusive_group()
    endpoint_group.add_argument(
        "--local", action="store_true", default=False,
        help="Use local Supabase endpoint (http://localhost:54321)",
    )
    endpoint_group.add_argument(
        "--remote", action="store_true", default=False,
        help="Use remote (deployed) Supabase endpoint",
    )

    # Auth
    parser.add_argument(
        "--token", type=str, default=None,
        help="Bearer token for authentication (JWT from Supabase auth)",
    )

    # Dataset
    parser.add_argument(
        "--dataset", type=str, default=None,
        help="Path to E2E evaluation dataset JSON",
    )
    parser.add_argument(
        "--generate-e2e-dataset", action="store_true", default=False,
        help="Generate an E2E dataset from the production benchmark",
    )

    # Other options
    parser.add_argument(
        "--delay", type=float, default=1.0,
        help="Seconds to delay between API calls (default: 1.0)",
    )
    parser.add_argument(
        "--timeout", type=int, default=30,
        help="HTTP request timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Path to write metrics JSON output",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", default=False,
        help="Show per-case details",
    )

    args = parser.parse_args()

    # Configure endpoints
    args.local_endpoint = os.environ.get(
        "SUPABASE_LOCAL_URL", "http://localhost:54321"
    )
    args.remote_endpoint = os.environ.get(
        "SUPABASE_URL",
        os.environ.get("SUPABASE_REMOTE_URL", "https://<your-project>.supabase.co"),
    )

    # Default token from environment
    if args.token is None:
        args.token = os.environ.get("SUPABASE_AUTH_TOKEN")

    # Generate E2E dataset mode
    if args.generate_e2e_dataset:
        script_dir = Path(__file__).parent
        prod_dataset = (
            script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
            / "graph_eval_production.json"
        )
        e2e_output = (
            script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
            / "graph_eval_e2e.json"
        )
        if not prod_dataset.exists():
            print(f"Production dataset not found at {prod_dataset}")
            sys.exit(1)
        generate_e2e_dataset(str(prod_dataset), str(e2e_output))
        return

    # Default dataset
    if args.dataset is None:
        script_dir = Path(__file__).parent
        e2e_dataset = (
            script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
            / "graph_eval_e2e.json"
        )
        if e2e_dataset.exists():
            args.dataset = str(e2e_dataset)
        else:
            # Fall back to production dataset (without expected_facts)
            prod_dataset = (
                script_dir / "supabase" / "functions" / "retrieve-context" / "eval"
                / "graph_eval_production.json"
            )
            if prod_dataset.exists():
                args.dataset = str(prod_dataset)
            else:
                print("No dataset found. Generate one with --generate-e2e-dataset")
                sys.exit(1)

    run_e2e_evaluation(args)


if __name__ == "__main__":
    main()
