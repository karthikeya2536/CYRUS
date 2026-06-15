// Phase 15 retrieval tests: temporal parsing + rerank boost.
// Run: deno test supabase/functions/retrieve-context/temporal.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { parseTemporal } from "../_shared/temporal.ts";
import { calculateTemporalBoost, rankResults } from "./ranker.ts";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

Deno.test("no temporal phrase -> hasTemporal false, boost 0", () => {
  const h = parseTemporal("what did Alice say about pricing", NOW);
  assertEquals(h.hasTemporal, false);
  assertEquals(calculateTemporalBoost({ created_at: new Date(NOW).toISOString() }, h, NOW), 0);
});

Deno.test("'last week' -> past window, in-window item boosted", () => {
  const h = parseTemporal("emails from last week about the launch", NOW);
  assert(h.hasTemporal);
  assertEquals(h.direction, "past");
  const inWindow = { received_at: new Date(NOW - 3 * day).toISOString() };
  const outWindow = { received_at: new Date(NOW - 60 * day).toISOString() };
  assert(calculateTemporalBoost(inWindow, h, NOW) > 0);
  assertEquals(calculateTemporalBoost(outWindow, h, NOW), 0);
});

Deno.test("'upcoming' -> future direction boosts future events only", () => {
  const h = parseTemporal("any upcoming meetings", NOW);
  assert(h.hasTemporal);
  assertEquals(h.direction, "future");
  const future = { start_time: new Date(NOW + 2 * day).toISOString() };
  const past = { start_time: new Date(NOW - 2 * day).toISOString() };
  assert(calculateTemporalBoost(future, h, NOW) > 0);
  assertEquals(calculateTemporalBoost(past, h, NOW), 0);
});

Deno.test("'last N days' extracts N-day window", () => {
  const h = parseTemporal("show me commitments from last 10 days", NOW);
  assert(h.hasTemporal);
  assertEquals(h.from, new Date(NOW - 10 * day).toISOString());
  assertEquals(h.to, new Date(NOW).toISOString());
});

Deno.test("normalization strips temporal tokens", () => {
  const h = parseTemporal("project phoenix status this week", NOW);
  assert(!/this week/i.test(h.normalizedQuery));
  assert(/phoenix/i.test(h.normalizedQuery));
});

Deno.test("rerank applies temporal boost additively, candidate set unchanged", () => {
  const h = parseTemporal("last week", NOW);
  const items = [
    { id: "a", hybrid_score: 0.5, received_at: new Date(NOW - 2 * day).toISOString() }, // in window
    { id: "b", hybrid_score: 0.5, received_at: new Date(NOW - 200 * day).toISOString() }, // out
  ];
  const ranked = rankResults(items, "general", [], h);
  assertEquals(ranked.length, 2); // no candidate dropped/added
  const a = ranked.find((r) => r.id === "a")!;
  const b = ranked.find((r) => r.id === "b")!;
  assert(a.finalScore > b.finalScore);
});
