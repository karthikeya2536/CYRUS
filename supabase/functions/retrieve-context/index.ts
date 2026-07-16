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
import { withTraceContext, startSpan, sendBufferedSpans } from "../_shared/trace.ts";

const RATE_LIMIT_PER_MIN = 30;

// Retrieval configuration surfaced to clients so feedback (Phase 13) can be
// attributed to the exact retrieval variant that produced a result.
const RETRIEVAL_VERSION = "v1";
const RETRIEVAL_CANDIDATE_LIMIT = 60; // 30 memories + 20 emails + 10 events
const EMBEDDING_MODEL = Deno.env.get("OMNIROUTE_EMBEDDING_MODEL") ?? "default-768";

// Phase 16: graph-based context expansion limits.
const GRAPH_MAX_HOPS = 2;
const GRAPH_MAX_EXPANDED_MEMORIES = 25;
const GRAPH_SEED_COUNT = 10;

serve(async (req: Request) => {
  const rootTraceId = crypto.randomUUID();
  const rootSpanId = crypto.randomUUID();

  return await withTraceContext({ trace_id: rootTraceId, span_id: rootSpanId }, async () => {
    const rootSpan = startSpan("retrieve-context", "http_request", { span_kind: "server", trace_id: rootTraceId });
    let adminClient: any = null;

    const corsHeaders = buildCorsHeaders(req);
    const requestId = newRequestId();
    const log = createLogger("retrieve-context", requestId);

    function jsonResponse(body: Record<string, unknown>, status = 200) {
      rootSpan.setStatus(status >= 400 ? "error" : "ok");
      rootSpan.end();
      if (adminClient) {
        const rt = (globalThis as any).EdgeRuntime;
        if (rt && typeof rt.waitUntil === "function") {
          rt.waitUntil(sendBufferedSpans(adminClient));
        } else {
          sendBufferedSpans(adminClient).catch(() => {});
        }
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'OPTIONS') {
      rootSpan.end();
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

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);

    const debugLogs = {
      authLength: authHeader?.length,
      tokenLength: token?.length,
      userError,
      user
    };
    console.log(JSON.stringify(debugLogs));

    if (userError || !user) {
      return jsonResponse({ error: "Invalid token", debug: debugLogs }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    adminClient = supabaseAdmin;
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
    const rankSpan = startSpan("retrieve-context", "rank_results");
    const temporal = parseTemporal(query);
    const rankedMemories = rankResults(memories, parsedQuery.intent, parsedQuery.entities, temporal);
    const rankedEmails = rankResults(emails, parsedQuery.intent, parsedQuery.entities, temporal);
    const rankedEvents = rankResults(events, parsedQuery.intent, parsedQuery.entities, temporal);
    rankSpan.setAttribute("candidates", memories.length + emails.length + events.length);
    rankSpan.end();

    // Compute graph intent for graph rendering
    let graphIntent = 'general';
    const queryLower = query.toLowerCase();
    if (queryLower.includes('block') || queryLower.includes('depend') || queryLower.includes('require')) {
      graphIntent = 'blocking';
    } else if (queryLower.includes('who') || queryLower.includes('whom')) {
      graphIntent = 'who';
    } else if (queryLower.includes('work') || queryLower.includes('working')) {
      graphIntent = 'working_on';
    }

    // Phase 16: graph-based context expansion. Walk the entity graph from
    // the top retrieved memories to related memories, then rerank them with the
    // existing ranker. Best-effort; never blocks retrieval.
    let rankedExpanded: any[] = [];
    const GRAPH_READ_ENABLED = Deno.env.get("GRAPH_READ_ENABLED") === "true";
    const GRAPH_RENDER_ENABLED = Deno.env.get("GRAPH_RENDER_ENABLED") === "true";

    const expandSpan = startSpan("retrieve-context", "graph_expansion");
    if (GRAPH_READ_ENABLED) {
      try {
        const seedIds = rankedMemories.slice(0, GRAPH_SEED_COUNT).map((m: any) => m.id).filter(Boolean);
        if (seedIds.length) {
          // Resolve memory IDs to graph node IDs
          const { data: nodes } = await supabaseAdmin.rpc("resolve_nodes_for_memories", {
            p_user_id: user.id,
            p_memory_ids: seedIds
          });

          if (nodes && nodes.length > 0) {
            const startNodeIds = nodes.map((n: any) => n.node_id);

            const traverseStart = Date.now();
            const { data: relations } = await supabaseAdmin.rpc("graph_render_relations", {
              p_user_id: user.id,
              p_start_node_ids: startNodeIds,
              p_max_hops: GRAPH_MAX_HOPS,
              p_limit: 5,
              p_graph_intent: graphIntent
            });
            const traverseLatency = Date.now() - traverseStart;
            expandSpan.setAttribute("graph_render_latency_ms", traverseLatency);
            expandSpan.setAttribute("graph_relations_rendered", relations?.length || 0);
            expandSpan.setAttribute("graph_nodes_resolved", nodes.length);

            if (relations && relations.length > 0) {
              // Sort graph relations by score descending for better presentation
              rankedExpanded = (relations || []).sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
            }
          }
        }
        expandSpan.end();
      } catch (_e) {
        log.warn("graph_expansion_failed");
        expandSpan.setStatus("error");
        expandSpan.end();
      }
    } else {
      expandSpan.end();
    }

    const allRanked = [...rankedMemories, ...rankedEmails, ...rankedEvents];
    const graphRelations = GRAPH_RENDER_ENABLED ? rankedExpanded : [];

    // 5. Assemble Context
    const assembleSpan = startSpan("retrieve-context", "assemble_context");
    const assembled = assembleContext(allRanked, graphRelations, 2000, 0.15); // Drop below 0.15 score
    assembleSpan.setAttribute("final_context_size", assembled.context.length);
    assembleSpan.end();

    // Phase B: reinforce ONLY memories that reached the final assembled context
    // (the rows actually sent to the LLM) — not every above-threshold candidate.
    // Single batched UPDATE via RPC; fire-and-forget so query latency is unchanged.
    try {
      const reinforcedIds = assembled.context
        .filter((c: any) => c.source === "memory")
        .map((c: any) => c.id)
        .filter(Boolean);
      if (reinforcedIds.length) {
        const p = supabaseAdmin.rpc("record_memory_retrievals", {
          p_user_id: user.id,
          ids: reinforcedIds,
        });
        const rt = (globalThis as any).EdgeRuntime;
        if (rt && typeof rt.waitUntil === "function") {
          rt.waitUntil(Promise.resolve(p).catch(() => {}));
        } else {
          await Promise.resolve(p).catch(() => {});
        }
      }
    } catch (_e) {
      log.warn("reinforcement_write_failed");
    }

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

    return jsonResponse({
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
      feedback: {
        run_id: retrievalRunId,
        retrieval_version: RETRIEVAL_VERSION,
        candidate_limit: RETRIEVAL_CANDIDATE_LIMIT,
        embedding_model: EMBEDDING_MODEL,
      }
    }, 200);

  } catch (_error) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
  });
});