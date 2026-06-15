export function calculateRecencyScore(dateString: string): number {
  if (!dateString) return 0;
  const itemDate = new Date(dateString).getTime();
  const now = Date.now();
  const diffDays = (now - itemDate) / (1000 * 60 * 60 * 24);
  
  if (diffDays < 0) return 1.0; // future events
  if (diffDays <= 1) return 1.0;
  if (diffDays <= 7) return 0.8;
  if (diffDays <= 30) return 0.5;
  if (diffDays <= 90) return 0.2;
  return 0;
}

export function calculateEntityScore(text: string, entities: string[]): number {
  if (!entities || entities.length === 0) return 0;
  let matchCount = 0;
  const lowerText = text.toLowerCase();
  for (const ent of entities) {
    if (lowerText.includes(ent.toLowerCase())) {
      matchCount++;
    }
  }
  return matchCount / entities.length;
}

import { type TemporalHint, itemTimestamp } from "../_shared/temporal.ts";

// Phase 15: additive temporal boost applied during reranking only. Returns a
// small non-negative bump so it never reorders against strong semantic signals
// on its own, but breaks ties toward the requested time window.
export function calculateTemporalBoost(item: any, hint: TemporalHint | null, nowMs: number = Date.now()): number {
  if (!hint || !hint.hasTemporal) return 0;
  const ds = itemTimestamp(item);
  if (!ds) return 0;
  const t = new Date(ds).getTime();
  if (Number.isNaN(t)) return 0;

  const from = hint.from ? Date.parse(hint.from) : null;
  const to = hint.to ? Date.parse(hint.to) : null;

  if (from !== null && to !== null) {
    return t >= from && t <= to ? 0.3 : 0;
  }
  if (hint.direction === "future") return t >= nowMs ? 0.3 : 0;
  if (hint.direction === "past") return t <= nowMs ? 0.2 : 0;
  if (hint.direction === "recent") return calculateRecencyScore(ds) * 0.3;
  return 0;
}

export function rankResults(items: any[], intent: string, entities: string[], temporal: TemporalHint | null = null) {
  return items.map(item => {
    const temporalBoost = calculateTemporalBoost(item, temporal);
    const finalScore = (item.hybrid_score || 0) + temporalBoost;

    // Phase 10 delegates primary ranking to schema.sql's additive model;
    // Phase 15 adds a temporal boost on top during reranking only.
    return {
      ...item,
      finalScore,
      _scores: {
        hybrid_score: item.hybrid_score,
        semantic: item.semantic_similarity,
        fts: item.fts_rank,
        effective_importance: item.effective_importance,
        temporal_boost: temporalBoost
      }
    };
  });
}
