import { rankResults } from "./supabase/functions/retrieve-context/ranker.ts";
import { recallAtK, mrr, ndcgAtK } from "./supabase/functions/retrieve-context/eval/metrics.ts";

const rand = () => Math.random();
const shuffle = (array: any[]) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
};

const JUNE23 = 1750636800000;
const DAY = 86400000;

const cases: any[] = [];

// Urgency must beat semantic
for (let i = 0; i < 15; i++) {
  const candidates = [];
  candidates.push({ id: "TARGET_URG", similarity_distance: 0.55, deadline_at: new Date(JUNE23 + 1 * DAY).toISOString() }); 
  for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.18 + rand() * 0.05 }); 
  for (let j = 0; j < 24; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  
  shuffle(candidates);
  cases.push({
    id: `urgency-beat-sem-${i}`,
    kind: "ranking",
    query: "urgency query",
    nowMs: JUNE23,
    candidates,
    relevant: ["TARGET_URG"]
  });
}

// Importance must beat semantic
for (let i = 0; i < 15; i++) {
  const candidates = [];
  candidates.push({ id: "TARGET_IMP", similarity_distance: 0.45, llm_importance: 0.9, system_importance: 0.9 });
  for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.18 + rand() * 0.05 });
  for (let j = 0; j < 24; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  
  shuffle(candidates);
  cases.push({
    id: `imp-beat-sem-${i}`,
    kind: "ranking",
    query: "importance query",
    nowMs: JUNE23,
    candidates,
    relevant: ["TARGET_IMP"]
  });
}

// Reinforcement breaks ties
for (let i = 0; i < 10; i++) {
  const candidates = [];
  candidates.push({ id: "TARGET_REINF", similarity_distance: 0.4, retrieval_count: 50 });
  for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.4, retrieval_count: 0 }); // tie on sem
  for (let j = 0; j < 24; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  
  shuffle(candidates);
  cases.push({
    id: `reinf-tie-break-${i}`,
    kind: "ranking",
    query: "reinforcement query",
    nowMs: JUNE23,
    candidates,
    relevant: ["TARGET_REINF"]
  });
}

// Temporal boost changes ordering
for (let i = 0; i < 10; i++) {
  const candidates = [];
  candidates.push({ id: "TARGET_TEMP", similarity_distance: 0.4, start_time: new Date(JUNE23 + 2 * DAY).toISOString() }); // future event
  for (let j = 0; j < 5; j++) candidates.push({ id: `NOISE_SEM_${j}`, similarity_distance: 0.35, start_time: new Date(JUNE23 - 100 * DAY).toISOString() }); // better sem, but past
  for (let j = 0; j < 24; j++) candidates.push({ id: `NOISE_RND_${j}`, similarity_distance: 0.5 + rand() * 0.4 });
  
  shuffle(candidates);
  cases.push({
    id: `temporal-boost-${i}`,
    kind: "ranking",
    query: "upcoming items",
    nowMs: JUNE23,
    temporal: { hasTemporal: true, direction: "future", start: null, end: null },
    candidates,
    relevant: ["TARGET_TEMP"]
  });
}

function evalRanker(name: string, rankFn: (c: any) => any[]) {
  let r5 = 0, r10 = 0, m = 0, n10 = 0;
  for (const c of cases) {
    const ranked = rankFn(c);
    const rel = new Set(c.relevant);
    r5 += recallAtK(ranked, rel, 5);
    r10 += recallAtK(ranked, rel, 10);
    m += mrr(ranked, rel);
    n10 += ndcgAtK(ranked, rel, 10);
  }
  const N = cases.length;
  console.log(`--- ${name} ---`);
  console.log(`recall@5:  ${(r5 / N).toFixed(3)}`);
  console.log(`recall@10: ${(r10 / N).toFixed(3)}`);
  console.log(`mrr:       ${(m / N).toFixed(3)}`);
  console.log(`ndcg@10:   ${(n10 / N).toFixed(3)}`);
  console.log();
}

console.log("Total Cases:", cases.length);

evalRanker("Full Ranker", (c) => {
  return rankResults(c.candidates, "general", [], c.temporal || null, c.nowMs)
    .sort((a: any, b: any) => b.finalScore - a.finalScore)
    .map((x: any) => x.id);
});

evalRanker("Identity Ranker", (c) => {
  return c.candidates.map((x: any) => x.id);
});

evalRanker("Semantic-Only Ranker", (c) => {
  return c.candidates.slice().sort((a: any, b: any) => (a.similarity_distance || 1) - (b.similarity_distance || 1)).map((x: any) => x.id);
});

evalRanker("Urgency-Disabled Ranker", (c) => {
  const modified = c.candidates.map((x: any) => ({...x, deadline_at: null, start_time: null}));
  return rankResults(modified, "general", [], c.temporal || null, c.nowMs)
    .sort((a: any, b: any) => b.finalScore - a.finalScore)
    .map((x: any) => x.id);
});

evalRanker("Reinforcement-Disabled Ranker", (c) => {
  const modified = c.candidates.map((x: any) => ({...x, retrieval_count: 0}));
  return rankResults(modified, "general", [], c.temporal || null, c.nowMs)
    .sort((a: any, b: any) => b.finalScore - a.finalScore)
    .map((x: any) => x.id);
});
