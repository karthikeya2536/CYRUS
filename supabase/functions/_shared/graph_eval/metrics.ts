// Pure ranking-quality metrics. No deps, no clock, no I/O.
// `ranked`: result ids ordered best-first. `relevant`: set of relevant ids.

export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

export function mrr(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  const limit = Math.min(k, ranked.length);
  for (let i = 0; i < limit; i++) {
    if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(k, relevant.size);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
