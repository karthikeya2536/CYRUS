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

// ---- Phase A weighted scoring. Weights are tunable named constants; they sum
// to 1.0 (true weights, not relative coefficients). Re-run the benchmark after
// changing any of them. ----
export const W_SEM = 0.50;
export const W_URG = 0.20;
export const W_IMP = 0.15;
export const W_REC = 0.10;
export const W_REINF = 0.05;

export const RECENCY_HALFLIFE_DAYS = 30;
export const REINF_CAP = 50;

const DAY_MS = 86400000;

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function semanticScore(item: any): number {
  const base = item.hybrid_score ??
    (item.similarity_distance !== undefined ? 1 - item.similarity_distance : 0);
  return clamp01(base);
}

export function importanceScore(item: any): number {
  const hasImp = item.llm_importance != null || item.system_importance != null;
  if (!hasImp) return 0.5; // emails/events have no importance signal
  return clamp01(Math.max(item.llm_importance ?? 0, item.system_importance ?? 0));
}

// memory -> created_at, email -> received_at, event -> start_time
function recencySource(item: any): string | null {
  return item.created_at ?? item.received_at ?? item.start_time ?? null;
}

export function recencyScore(dateString: string | null, nowMs: number): number {
  if (!dateString) return 0;
  const t = new Date(dateString).getTime();
  if (Number.isNaN(t)) return 0;
  const ageDays = (nowMs - t) / DAY_MS;
  if (ageDays <= 0) return 1.0; // now/future
  return clamp01(Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS));
}

export function reinforcementScore(item: any): number {
  const count = typeof item.retrieval_count === "number" ? item.retrieval_count : 0;
  if (count <= 0) return 0;
  return clamp01(Math.log1p(count) / Math.log1p(REINF_CAP));
}

// memory -> deadline_at, event -> start_time; emails have neither
function deadlineSource(item: any): string | null {
  return item.deadline_at ?? item.start_time ?? null;
}

// Piecewise urgency curve (explainable buckets). d = days until deadline.
export function urgencyScore(dateString: string | null, nowMs: number): number {
  if (!dateString) return 0;
  const t = new Date(dateString).getTime();
  if (Number.isNaN(t)) return 0;
  const d = (t - nowMs) / DAY_MS;
  if (d >= 0) {
    if (d > 30) return 0.0;
    if (d > 14) return 0.2;
    if (d > 7) return 0.4;
    if (d > 3) return 0.7;
    return 1.0; // 3 >= d >= 0
  }
  const late = -d;
  if (late <= 2) return 1.0;
  if (late <= 7) return 0.5;
  return 0.0;
}

const r3 = (x: number) => parseFloat(x.toFixed(3));

export function rankResults(
  items: any[],
  intent: string,
  entities: string[],
  temporal: TemporalHint | null = null,
  nowMs: number = Date.now(),
) {
  return items.map((item) => {
    const semantic = semanticScore(item);
    const importance = importanceScore(item);
    const recency = recencyScore(recencySource(item), nowMs);
    const reinforcement = reinforcementScore(item);
    const urgency = urgencyScore(deadlineSource(item), nowMs);
    const temporalBoost = calculateTemporalBoost(item, temporal, nowMs);

    const finalScore =
      W_SEM * semantic +
      W_URG * urgency +
      W_IMP * importance +
      W_REC * recency +
      W_REINF * reinforcement +
      temporalBoost;

    return {
      ...item,
      finalScore,
      _scores: {
        semantic: r3(semantic),
        importance: r3(importance),
        recency: r3(recency),
        reinforcement: r3(reinforcement),
        urgency: r3(urgency),
        temporal_boost: r3(temporalBoost),
        final: r3(finalScore),
      },
    };
  });
}
