import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { LLMRouter } from "../_shared/llm-router.ts";
import { QueryParser } from "../_shared/query-parser.ts";
import { rankResults } from "./ranker.ts";
import { assembleContext } from "./assembler.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { isPayloadTooLarge } from "../_shared/payload.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { isValidQuery, MAX_QUERY_LENGTH } from "../_shared/validators.ts";
import { parseTemporal } from "../_shared/temporal.ts";
import { getUserPlan, consumeQuota } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 30;

// Retrieval configuration surfaced to clients so feedback (Phase 13) can be
// attributed to the exact retrieval variant that produced a result.
const RETRIEVAL_VERSION = "v1";
const RETRIEVAL_CANDIDATE_LIMIT = 60; // 30 memories + 20 emails + 10 events
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") ?? "default-768";

// Phase 16: graph-based context expansion limits.
const GRAPH_MAX_HOPS = 2;
const GRAPH_MAX_EXPANDED_MEMORIES = 25;
const GRAPH_SEED_COUNT = 10;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("retrieve-context", requestId);

  function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify JWT and extract user identity
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const rl = await checkRateLimit(supabaseAdmin, user.id, "retrieve-context", RATE_LIMIT_PER_MIN);
    if (rl.limited) {
      return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
    }

    if (isPayloadTooLarge(req)) {
      return jsonResponse({ error: "Payload too large" }, 413);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const { query } = body as { query?: string };

    if (!isValidQuery(query)) {
      return jsonResponse({ error: `Invalid query (1-${MAX_QUERY_LENGTH} chars required)` }, 400);
    }

    // Plan quota: meter AI queries per day (free plan is capped).
    const plan = await getUserPlan(supabaseAdmin, user.id);
    const quota = await consumeQuota(supabaseAdmin, user.id, "ai_queries", plan);
    if (!quota.allowed) {
      return jsonResponse({
        error: `Daily AI query limit reached (${quota.limit}/day on the ${plan} plan). Upgrade for unlimited queries.`,
        code: "upgrade_required",
      }, 402);
    }

    const startTime = Date.now();

    // Phase 12 telemetry: collected best-effort, flushed after the response is
    // assembled. Never alters retrieval behavior.
    const telemetryFailures: { stage: string; message: string }[] = [];
    let retrievalRunId: string | null = null;

    // 1. Parse Query
    const parsedQuery = await QueryParser.parse(query);

    // 2. Generate Query Embedding (graceful fallback if unavailable)
    let queryEmbedding: number[] = [];
    let embeddingAvailable = false;
    try {
      queryEmbedding = await LLMRouter.generateEmbedding(query);
      if (queryEmbedding.length !== 768) {
        throw new Error(`Invalid embedding length: ${queryEmbedding?.length}`);
      }
      embeddingAvailable = true;
    } catch (_e) {
      log.warn("embedding_generation_failed_text_only");
      telemetryFailures.push({ stage: "embedding", message: "embedding_generation_failed" });
    }

    // 3. Retrieve from Postgres via RPCs
    // If no embedding, use a zero vector placeholder for FTS-only search
    const zeroEmbedding = '[' + Array(768).fill(0).join(',') + ']';

    const [memRes, emailRes, eventRes] = embeddingAvailable
      ? await Promise.all([
          supabaseUser.rpc('hybrid_search_memories', { query_text: query, query_embedding: `[${queryEmbedding.join(',')}]`, match_count: 30 }),
          supabaseUser.rpc('hybrid_search_emails', { query_text: query, query_embedding: `[${queryEmbedding.join(',')}]`, match_count: 20 }),
          supabaseUser.rpc('hybrid_search_events', { query_text: query, query_embedding: `[${queryEmbedding.join(',')}]`, match_count: 10 })
        ])
      : await Promise.all([
          supabaseUser.rpc('hybrid_search_memories', { query_text: query, query_embedding: zeroEmbedding, match_count: 30 }),
          supabaseUser.rpc('hybrid_search_emails', { query_text: query, query_embedding: zeroEmbedding, match_count: 20 }),
          supabaseUser.rpc('hybrid_search_events', { query_text: query, query_embedding: zeroEmbedding, match_count: 10 })
        ]);

    if (memRes.error) { log.error("memory_search_error"); telemetryFailures.push({ stage: "memory_search", message: "rpc_error" }); }
    if (emailRes.error) { log.error("email_search_error"); telemetryFailures.push({ stage: "email_search", message: "rpc_error" }); }
    if (eventRes.error) { log.error("event_search_error"); telemetryFailures.push({ stage: "event_search", message: "rpc_error" }); }

    const memories = memRes.data || [];
    const emails = emailRes.data || [];
    const events = eventRes.data || [];

    // 4. Rank Results (Phase 15: temporal boost is reranking-only; candidate
    // generation above is unchanged).
    const temporal = parseTemporal(query);
    const rankedMemories = rankResults(memories, parsedQuery.intent, parsedQuery.entities, temporal);
    const rankedEmails = rankResults(emails, parsedQuery.intent, parsedQuery.entities, temporal);
    const rankedEvents = rankResults(events, parsedQuery.intent, parsedQuery.entities, temporal);

    // 4b. Phase 16: graph-based context expansion. Walk the entity graph from
    // the top retrieved memories to related memories, then rerank them with the
    // existing ranker (no ranking redesign). Best-effort; never blocks retrieval.
    let rankedExpanded: any[] = [];
    try {
      const seedIds = rankedMemories.slice(0, GRAPH_SEED_COUNT).map((m: any) => m.id).filter(Boolean);
      if (seedIds.length) {
        const { data: expanded } = await supabaseAdmin.rpc("graph_expand_memories", {
          p_user_id: user.id,
          seed_ids: seedIds,
          max_hops: GRAPH_MAX_HOPS,
          max_results: GRAPH_MAX_EXPANDED_MEMORIES,
        });
        const known = new Set(rankedMemories.map((m: any) => m.id));
        const exItems = (expanded || [])
          .filter((e: any) => !known.has(e.id))
          .map((e: any) => ({ ...e, hybrid_score: e.hops === 1 ? 0.4 : 0.25, graph_expanded: true }));
        rankedExpanded = rankResults(exItems, parsedQuery.intent, parsedQuery.entities, temporal);
      }
    } catch (_e) {
      log.warn("graph_expansion_failed");
    }

    const allRanked = [...rankedMemories, ...rankedEmails, ...rankedEvents, ...rankedExpanded];

    // 5. Assemble Context
    const assembled = assembleContext(allRanked, 2000, 0.3); // Drop below 0.3 score

    const latencyMs = Date.now() - startTime;

    // 6. Log Retrieval (use supabaseUser to respect RLS)
    await supabaseUser.from('retrieval_logs').insert({
      query,
      intent: parsedQuery.intent,
      entities: parsedQuery.entities,
      results_count: assembled.metadata.included,
      latency_ms: latencyMs
    });

    // 6b. Phase 12 observability telemetry (best-effort; never blocks response).
    try {
      const topScore = (arr: any[]) =>
        arr.length ? Math.max(...arr.map((x) => (typeof x?.score === "number" ? x.score : 0))) : null;

      const { data: runRow } = await supabaseAdmin.from("retrieval_runs").insert({
        user_id: user.id,
        intent: parsedQuery.intent,
        embedding_available: embeddingAvailable,
        candidates_memories: memories.length,
        candidates_emails: emails.length,
        candidates_events: events.length,
        included: assembled.metadata.included,
        latency_ms: latencyMs,
      }).select("id").single();

      if (runRow) {
        retrievalRunId = runRow.id;
        await supabaseAdmin.from("retrieval_rank_events").insert([
          { run_id: runRow.id, source_type: "memory", candidate_count: memories.length, ranked_count: rankedMemories.length, top_score: topScore(rankedMemories) },
          { run_id: runRow.id, source_type: "email", candidate_count: emails.length, ranked_count: rankedEmails.length, top_score: topScore(rankedEmails) },
          { run_id: runRow.id, source_type: "event", candidate_count: events.length, ranked_count: rankedEvents.length, top_score: topScore(rankedEvents) },
        ]);
        if (telemetryFailures.length) {
          await supabaseAdmin.from("retrieval_failures").insert(
            telemetryFailures.map((f) => ({ run_id: runRow.id, user_id: user.id, stage: f.stage, message: f.message })),
          );
        }
      }
    } catch (_e) {
      log.warn("retrieval_telemetry_write_failed");
    }

    return new Response(JSON.stringify({
      context: assembled.context,
      metadata: { 
        ...assembled.metadata, 
        embeddingAvailable,
        debugInfo: {
          question: query,
          embeddingExists: !!queryEmbedding,
          embeddingLength: queryEmbedding?.length,
          first5Values: queryEmbedding?.slice(0,5),
          zeroEmbeddingUsed: !embeddingAvailable,
          zeroEmbeddingLength: zeroEmbedding.split(',').length
        }
      },
      parsed: parsedQuery,
      latencyMs,
      // Feedback attribution (Phase 13): client echoes these to retrieval-feedback.
      feedback: {
        run_id: retrievalRunId,
        retrieval_version: RETRIEVAL_VERSION,
        candidate_limit: RETRIEVAL_CANDIDATE_LIMIT,
        embedding_model: EMBEDDING_MODEL,
      }
    }), {
      status: 200, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (_error) {
    log.error("unhandled error");
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
