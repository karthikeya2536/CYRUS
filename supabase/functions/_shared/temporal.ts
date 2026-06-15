// Phase 15: temporal query support. Pure, deterministic, dependency-free.
// Used ONLY for reranking — never to alter candidate generation.

export interface TemporalHint {
  hasTemporal: boolean;
  direction: "past" | "future" | "recent" | null;
  from: string | null; // ISO
  to: string | null;    // ISO
  normalizedQuery: string;
}

const DAY = 24 * 60 * 60 * 1000;

// Phrases that carry temporal meaning. Order matters (longest/most specific
// first) so normalization strips the right span.
const TEMPORAL_PATTERNS: { re: RegExp; kind: "past" | "future" | "recent"; days?: number; whole?: "day" | "week" | "month" | "year" }[] = [
  { re: /\blast\s+(\d{1,3})\s+days?\b/i, kind: "past" },              // "last N days" (N captured)
  { re: /\bpast\s+(\d{1,3})\s+days?\b/i, kind: "past" },
  { re: /\byesterday\b/i, kind: "past", days: 1 },
  { re: /\blast\s+week\b/i, kind: "past", whole: "week" },
  { re: /\bthis\s+week\b/i, kind: "recent", whole: "week" },
  { re: /\blast\s+month\b/i, kind: "past", whole: "month" },
  { re: /\bthis\s+month\b/i, kind: "recent", whole: "month" },
  { re: /\blast\s+year\b/i, kind: "past", whole: "year" },
  { re: /\bthis\s+year\b/i, kind: "recent", whole: "year" },
  { re: /\b(today)\b/i, kind: "recent", days: 1 },
  { re: /\b(tomorrow)\b/i, kind: "future", days: 1 },
  { re: /\bnext\s+week\b/i, kind: "future", whole: "week" },
  { re: /\bupcoming\b/i, kind: "future" },
  { re: /\bsoon\b/i, kind: "future" },
  { re: /\b(recent|recently|latest|lately)\b/i, kind: "recent" },
];

function isoStart(t: number): string {
  return new Date(t).toISOString();
}

// Parse a query into a temporal hint. `nowMs` is injectable for deterministic
// tests.
export function parseTemporal(query: string, nowMs: number = Date.now()): TemporalHint {
  let direction: TemporalHint["direction"] = null;
  let from: number | null = null;
  let to: number | null = null;
  let normalized = query;
  let matched = false;

  for (const p of TEMPORAL_PATTERNS) {
    const m = query.match(p.re);
    if (!m) continue;
    matched = true;
    direction = p.kind;
    normalized = normalized.replace(p.re, " ");

    if (p.re.source.includes("\\d")) {
      const n = parseInt(m[1], 10);
      from = nowMs - n * DAY;
      to = nowMs;
    } else if (p.days) {
      if (p.kind === "future") { from = nowMs; to = nowMs + p.days * DAY; }
      else { from = nowMs - p.days * DAY; to = nowMs; }
    } else if (p.whole) {
      const span = p.whole === "week" ? 7 * DAY : p.whole === "month" ? 30 * DAY : p.whole === "year" ? 365 * DAY : DAY;
      if (p.kind === "future") { from = nowMs; to = nowMs + span; }
      else if (p.kind === "recent") { from = nowMs - span; to = nowMs + span; }
      else { from = nowMs - span; to = nowMs; }
    } else {
      // Open-ended direction (upcoming/recent/soon): no hard window.
      if (p.kind === "future") { from = nowMs; to = null; }
      else if (p.kind === "past") { from = null; to = nowMs; }
      else { from = nowMs - 30 * DAY; to = nowMs; } // recent ~ last 30d
    }
    break; // one temporal anchor is enough
  }

  normalized = normalized.replace(/\s+/g, " ").trim();

  return {
    hasTemporal: matched,
    direction,
    from: from !== null ? isoStart(from) : null,
    to: to !== null ? isoStart(to) : null,
    normalizedQuery: normalized.length ? normalized : query.trim(),
  };
}

// Pick the most relevant timestamp on a retrieved item across sources.
export function itemTimestamp(item: any): string | null {
  return item?.received_at || item?.start_time || item?.last_seen_at || item?.created_at || null;
}
