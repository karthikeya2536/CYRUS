import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rankResults } from "../ranker.ts";
import { recallAtK, mrr, ndcgAtK } from "./metrics.ts";

type Case = {
  id: string;
  kind: "retrieval" | "ranking" | "urgency";
  query: string;
  nowMs?: number;
  candidates: any[];
  relevant: string[];
};

// Baseline thresholds. Ratchet upward as the model improves; never lower silently.
const THRESHOLDS = { recall5: 0.70, recall10: 0.85, mrr: 0.60, ndcg10: 0.70 };

const cases: Case[] = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/cases.json", import.meta.url)),
);

Deno.test("benchmark: fixture corpus shape", () => {
  assert(cases.length >= 50, `expected >= 50 cases, got ${cases.length}`);
  const by = (k: string) => cases.filter((c) => c.kind === k).length;
  assert(by("retrieval") >= 20, "need >= 20 retrieval cases");
  assert(by("ranking") >= 20, "need >= 20 ranking cases");
  assert(by("urgency") >= 10, "need >= 10 urgency cases");
});

Deno.test("benchmark: averaged metrics meet baseline thresholds", () => {
  let r5 = 0, r10 = 0, m = 0, n10 = 0;
  for (const c of cases) {
    const ranked = rankResults(c.candidates, "general", [], null, c.nowMs ?? Date.now())
      .sort((a: any, b: any) => b.finalScore - a.finalScore)
      .map((x: any) => x.id as string);
    const rel = new Set(c.relevant);
    r5 += recallAtK(ranked, rel, 5);
    r10 += recallAtK(ranked, rel, 10);
    m += mrr(ranked, rel);
    n10 += ndcgAtK(ranked, rel, 10);
  }
  const N = cases.length;
  const avg = { recall5: r5 / N, recall10: r10 / N, mrr: m / N, ndcg10: n10 / N };
  console.log("benchmark metrics:", avg);
  assert(avg.recall5 >= THRESHOLDS.recall5, `recall@5 ${avg.recall5} < ${THRESHOLDS.recall5}`);
  assert(avg.recall10 >= THRESHOLDS.recall10, `recall@10 ${avg.recall10} < ${THRESHOLDS.recall10}`);
  assert(avg.mrr >= THRESHOLDS.mrr, `mrr ${avg.mrr} < ${THRESHOLDS.mrr}`);
  assert(avg.ndcg10 >= THRESHOLDS.ndcg10, `ndcg@10 ${avg.ndcg10} < ${THRESHOLDS.ndcg10}`);
});
