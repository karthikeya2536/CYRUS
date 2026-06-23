import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recallAtK, mrr, ndcgAtK } from "./metrics.ts";

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-4;

Deno.test("recallAtK counts relevant hits in top-k over total relevant", () => {
  // top2 = [a,b]; relevant = {a,c}; 1 hit / 2 relevant = 0.5
  assertEquals(recallAtK(["a", "b", "c"], new Set(["a", "c"]), 2), 0.5);
  // all relevant found
  assertEquals(recallAtK(["a", "c"], new Set(["a", "c"]), 5), 1);
  // empty relevant -> 0 (no division by zero)
  assertEquals(recallAtK(["a"], new Set<string>(), 5), 0);
});

Deno.test("mrr is reciprocal rank of first relevant hit", () => {
  assertEquals(mrr(["x", "a"], new Set(["a"])), 0.5);   // first hit at rank 2
  assertEquals(mrr(["a", "x"], new Set(["a"])), 1);     // first hit at rank 1
  assertEquals(mrr(["x", "y"], new Set(["a"])), 0);     // no hit
});

Deno.test("ndcgAtK normalizes DCG by ideal DCG", () => {
  // relevant={b}; b at index1 -> dcg=1/log2(3)=0.63093; idcg(1 relevant)=1/log2(2)=1
  if (!approx(ndcgAtK(["a", "b"], new Set(["b"]), 2), 0.63093)) throw new Error("ndcg single");
  // perfect ordering -> 1.0
  if (!approx(ndcgAtK(["a", "b"], new Set(["a", "b"]), 2), 1)) throw new Error("ndcg perfect");
});
