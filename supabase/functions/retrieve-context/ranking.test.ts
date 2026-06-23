import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  rankResults, urgencyScore, reinforcementScore, importanceScore, recencyScore,
  W_SEM, W_URG, W_IMP, W_REC, W_REINF,
} from "./ranker.ts";

const approx = (a: number, b: number) => Math.abs(a - b) < 1e-3;
const JUNE23 = new Date("2026-06-23T00:00:00Z").getTime();

Deno.test("urgencyScore piecewise upcoming buckets", () => {
  const day = 86400000;
  assertEquals(urgencyScore(new Date(JUNE23 + 40 * day).toISOString(), JUNE23), 0.0); // >30
  assertEquals(urgencyScore(new Date(JUNE23 + 17 * day).toISOString(), JUNE23), 0.2); // 30>=d>14
  assertEquals(urgencyScore(new Date(JUNE23 + 10 * day).toISOString(), JUNE23), 0.4); // 14>=d>7
  assertEquals(urgencyScore(new Date(JUNE23 + 5 * day).toISOString(), JUNE23), 0.7);  // 7>=d>3
  assertEquals(urgencyScore(new Date(JUNE23 + 2 * day).toISOString(), JUNE23), 1.0);  // 3>=d>=0
});

Deno.test("urgencyScore piecewise overdue buckets", () => {
  const day = 86400000;
  assertEquals(urgencyScore(new Date(JUNE23 - 1 * day).toISOString(), JUNE23), 1.0); // 0..2 late
  assertEquals(urgencyScore(new Date(JUNE23 - 5 * day).toISOString(), JUNE23), 0.5); // 2..7 late
  assertEquals(urgencyScore(new Date(JUNE23 - 9 * day).toISOString(), JUNE23), 0.0); // >7 late
  assertEquals(urgencyScore(null, JUNE23), 0);                                       // no deadline
});

Deno.test("urgencyScore: past events do not get urgency, but past deadlines do", () => {
  const day = 86400000;
  assertEquals(urgencyScore(new Date(JUNE23 - 1 * day).toISOString(), JUNE23, false), 1.0); 
  assertEquals(urgencyScore(new Date(JUNE23 - 1 * day).toISOString(), JUNE23, true), 0.0);
  assertEquals(urgencyScore(new Date(JUNE23 + 2 * day).toISOString(), JUNE23, true), 1.0);
});


Deno.test("reinforcementScore saturates and clamps", () => {
  assertEquals(reinforcementScore({ retrieval_count: 0 }), 0);
  assertEquals(reinforcementScore({}), 0);
  const a = reinforcementScore({ retrieval_count: 2 });
  const b = reinforcementScore({ retrieval_count: 20 });
  if (!(b > a && b <= 1)) throw new Error("expected saturating growth <= 1");
});

Deno.test("importanceScore defaults to 0.5 when absent, else max of the two", () => {
  assertEquals(importanceScore({}), 0.5);
  assertEquals(importanceScore({ llm_importance: 0.9, system_importance: 0.3 }), 0.9);
});

Deno.test("recencyScore decays from 1.0 and treats future as 1.0", () => {
  assertEquals(recencyScore(new Date(JUNE23 + 86400000).toISOString(), JUNE23), 1.0); // future
  if (!(recencyScore(new Date(JUNE23 - 86400000 * 60).toISOString(), JUNE23) < 0.5)) {
    throw new Error("60-day-old item should decay below 0.5");
  }
});

Deno.test("rankResults: urgent low-semantic memory can beat high-semantic non-urgent", () => {
  const day = 86400000;
  const urgent = { id: "A", similarity_distance: 0.55, deadline_at: new Date(JUNE23 + 1 * day).toISOString() }; // sem .45, urg 1.0
  const similar = { id: "B", similarity_distance: 0.18 }; // sem .82, urg 0
  const [ra, rb] = rankResults([urgent, similar], "general", [], null, JUNE23);
  // both get the .15*0.5 default-importance term, so it cancels in the compare:
  // A = .50*.45 + .20*1.0 + .075 = .500 ; B = .50*.82 + .075 = .485  -> A wins
  if (!(ra.finalScore > rb.finalScore)) throw new Error("urgent item should outrank");
  assertEquals(ra._scores.urgency, 1.0);
});

Deno.test("rankResults: weights sum to 1.0", () => {
  if (!approx(W_SEM + W_URG + W_IMP + W_REC + W_REINF, 1.0)) throw new Error("weights must sum to 1");
});
