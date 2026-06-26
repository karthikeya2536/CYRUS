import { recallAtK, mrr, ndcgAtK } from "./supabase/functions/retrieve-context/eval/metrics.ts";

const cases = JSON.parse(await Deno.readTextFile("./supabase/functions/retrieve-context/eval/fixtures/cases.json"));

let r5 = 0, m = 0;
for (const c of cases) {
  // BROKEN RANKER: Just return candidates in original order
  const ranked = c.candidates.map((x: any) => x.id);
  const rel = new Set(c.relevant);
  r5 += recallAtK(ranked, rel, 5);
  m += mrr(ranked, rel);
}
const N = cases.length;
console.log("Original Order:", { recall5: r5 / N, mrr: m / N });

let r5_rev = 0, m_rev = 0;
for (const c of cases) {
  // BROKEN RANKER: Reverse order
  const ranked = c.candidates.map((x: any) => x.id).reverse();
  const rel = new Set(c.relevant);
  r5_rev += recallAtK(ranked, rel, 5);
  m_rev += mrr(ranked, rel);
}
console.log("Reverse Order:", { recall5: r5_rev / N, mrr: m_rev / N });
