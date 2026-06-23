// Optional, opt-in end-to-end retrieval harness. NOT a CI gate.
// Usage:
//   SUPABASE_URL=http://localhost:54321 USER_JWT=<jwt> node scripts/benchmark-retrieval.mjs
// Edit CASES below to reference real seeded memory ids in your local stack.
const URL_BASE = process.env.SUPABASE_URL;
const JWT = process.env.USER_JWT;
if (!URL_BASE || !JWT) {
  console.error("Set SUPABASE_URL and USER_JWT env vars."); process.exit(1);
}

const CASES = [
  // { query: "what deadline is approaching?", relevant: ["<memory-uuid>"] },
];

function recallAtK(ranked, relevant, k) {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

let r5 = 0, r10 = 0;
for (const c of CASES) {
  const res = await fetch(`${URL_BASE}/functions/v1/retrieve-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify({ query: c.query }),
  });
  const data = await res.json();
  const ranked = (data.context || []).map((x) => x.id);
  const rel = new Set(c.relevant);
  r5 += recallAtK(ranked, rel, 5);
  r10 += recallAtK(ranked, rel, 10);
}
const n = CASES.length || 1;
console.log({ cases: CASES.length, recall5: r5 / n, recall10: r10 / n });
