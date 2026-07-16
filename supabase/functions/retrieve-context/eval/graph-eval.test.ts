import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GraphEvalEngine, type GraphEvalDataset } from "./graph-eval.ts";
import { recallAtK } from "../../_shared/graph_eval/metrics.ts";

// Baseline thresholds. Ratchet upward as the system improves; never lower silently.
//
// Note: the RPC only boosts collaborates_on/contact_for/mentioned_by under "who"
// intent (not works_on), and LIMIT 5 caps results. These thresholds reflect the
// RPC's actual behavior and should rise if the RPC's boost lists are expanded.
const THRESHOLDS = {
  // General retrieval quality
  recall5: 0.80,      // % of expected relations in top 5
  recall10: 0.80,     // same as recall5 since LIMIT=5; maintained for consistency
  mrr: 0.70,          // reciprocal rank of first relevant result
  ndcg10: 0.70,       // graded relevance at rank 10

  // Graph health
  genericEdgePct: 25, // % of generic edges among outgoing edges from start nodes

  // Intent-specific accuracy
  dependencyTop1: 0.65,  // blocking queries: top-1 hit rate
  dependencyTop5: 0.75,  // blocking queries: top-5 hit rate
  peopleTop1: 0.30,      // who queries: top-1 (low because who doesn't boost works_on)
  peopleTop5: 0.80,      // who queries: top-5

  // Traversal efficiency
  avgHops: 1.50,      // average hops per traversed edge
};

const dataset: GraphEvalDataset = JSON.parse(
  await Deno.readTextFile(new URL("./graph-eval-dataset.json", import.meta.url)),
);

const engine = new GraphEvalEngine(dataset);

Deno.test("graph-eval: fixture corpus shape", () => {
  const N = dataset.cases.length;
  assert(N >= 50, `expected >= 50 cases, got ${N}`);
  assert(dataset.graph.nodes.length >= 20, `expected >= 20 nodes, got ${dataset.graph.nodes.length}`);
  assert(dataset.graph.edges.length >= 30, `expected >= 30 edges, got ${dataset.graph.edges.length}`);

  const by = (k: string) => dataset.cases.filter((c) => c.intent === k).length;
  assert(by("blocking") >= 12, `need >= 12 blocking cases, got ${by("blocking")}`);
  assert(by("who") >= 10, `need >= 10 who cases, got ${by("who")}`);
  assert(by("working_on") >= 8, `need >= 8 working_on cases, got ${by("working_on")}`);
  assert(by("general") >= 10, `need >= 10 general cases, got ${by("general")}`);
});

Deno.test("graph-eval: all graph nodes referenced in cases exist in the graph", () => {
  const allNodeKeys = new Set(dataset.graph.nodes.map((n) => n.key));
  for (const c of dataset.cases) {
    for (const key of c.start_node_keys) {
      assert(allNodeKeys.has(key), `case "${c.id}": start node "${key}" not found in graph`);
    }
    for (const rel of c.expected_relations) {
      assert(allNodeKeys.has(rel.source), `case "${c.id}": expected source "${rel.source}" not found in graph`);
      assert(allNodeKeys.has(rel.target), `case "${c.id}": expected target "${rel.target}" not found in graph`);
    }
  }
});

Deno.test("graph-eval: individual case recall@5 ≥ 0.50 (soft check)", () => {
  const lowRecall: string[] = [];

  for (const c of dataset.cases) {
    const { results } = engine.traverse(c);
    const rankedKeys = results.map(
      (r) => `${r.source_node}|${r.relationship_type}|${r.target_node}`,
    );
    const expectedKeys = new Set(
      c.expected_relations.map((r) => `${r.source}|${r.relationship}|${r.target}`),
    );

    if (expectedKeys.size === 0) continue; // empty-result cases have nothing to miss

    const r5 = recallAtK(rankedKeys, expectedKeys, 5);
    if (r5 < 0.50) {
      const resultStr = results.map(
        (r) => `  ${r.source_node} --[${r.relationship_type}]--> ${r.target_node} (${r.score.toFixed(3)})`,
      ).join("\n");
      lowRecall.push(
        `Case "${c.id}" (intent=${c.intent}, query="${c.query}"): recall@5=${r5.toFixed(3)}\n` +
        `  Results:\n${resultStr || "  (none)"}\n` +
        `  Expected (${c.expected_relations.length}):\n` +
        c.expected_relations.map((r) => `  ${r.source} --[${r.relationship}]--> ${r.target}`).join("\n"),
      );
    }
  }

  if (lowRecall.length > 0) {
    console.error("Cases with recall@5 < 0.50:\n" + lowRecall.join("\n\n"));
  }
  assert(lowRecall.length === 0, `${lowRecall.length} cases have recall@5 < 0.50`);
});

Deno.test("graph-eval: averaged metrics meet baseline thresholds", () => {
  const metrics = engine.evaluate(dataset.cases);

  console.log("graph-eval metrics:", JSON.stringify(metrics, null, 2));

  assert(metrics.recall5 >= THRESHOLDS.recall5,
    `recall@5 ${metrics.recall5.toFixed(3)} < ${THRESHOLDS.recall5}`);
  assert(metrics.recall10 >= THRESHOLDS.recall10,
    `recall@10 ${metrics.recall10.toFixed(3)} < ${THRESHOLDS.recall10}`);
  assert(metrics.mrr >= THRESHOLDS.mrr,
    `mrr ${metrics.mrr.toFixed(3)} < ${THRESHOLDS.mrr}`);
  assert(metrics.ndcg10 >= THRESHOLDS.ndcg10,
    `ndcg@10 ${metrics.ndcg10.toFixed(3)} < ${THRESHOLDS.ndcg10}`);
  assert(metrics.genericEdgePct <= THRESHOLDS.genericEdgePct,
    `genericEdgePct ${metrics.genericEdgePct.toFixed(1)}% > ${THRESHOLDS.genericEdgePct}%`);
  assert(metrics.dependencyTop1 >= THRESHOLDS.dependencyTop1,
    `dependencyTop1 ${metrics.dependencyTop1.toFixed(3)} < ${THRESHOLDS.dependencyTop1}`);
  assert(metrics.peopleTop1 >= THRESHOLDS.peopleTop1,
    `peopleTop1 ${metrics.peopleTop1.toFixed(3)} < ${THRESHOLDS.peopleTop1}`);
  assert(metrics.avgHops <= THRESHOLDS.avgHops,
    `avgHops ${metrics.avgHops.toFixed(3)} > ${THRESHOLDS.avgHops}`);
  assert(metrics.dependencyTop5 >= THRESHOLDS.dependencyTop5,
    `dependencyTop5 ${metrics.dependencyTop5.toFixed(3)} < ${THRESHOLDS.dependencyTop5}`);
  assert(metrics.peopleTop5 >= THRESHOLDS.peopleTop5,
    `peopleTop5 ${metrics.peopleTop5.toFixed(3)} < ${THRESHOLDS.peopleTop5}`);
});

Deno.test("graph-eval: traversal correctly filters generic relationships", () => {
  // Verify that no generic relationships leak into results
  const genericRelations = ["associated_with", "regarding", "involved_in", "mentioned", "interested_in"];
  const genericEdges = dataset.graph.edges.filter(
    (e) => genericRelations.includes(e.relationship),
  );
  assert(genericEdges.length > 0, "dataset should contain generic edges to test filtering");

  for (const c of dataset.cases) {
    const { results } = engine.traverse(c);
    for (const r of results) {
      const isGeneric = genericRelations.includes(r.relationship_type);
      assert(!isGeneric, `Case "${c.id}": generic relationship "${r.relationship_type}" leaked into results`);
    }
  }
});
