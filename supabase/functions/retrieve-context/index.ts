import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { supabaseAdmin, LLMRouter } from "../_shared/llm-router.ts";
import { QueryParser } from "../_shared/query-parser.ts";
import { rankResults } from "./ranker.ts";
import { assembleContext } from "./assembler.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
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

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }

    const userId = user.id;

    const { query } = await req.json();

    if (!query) {
      return jsonResponse({ error: "Missing query" }, 400);
    }

    const startTime = Date.now();

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
      console.log("Question:", query);
      console.log("Embedding exists:", !!queryEmbedding);
      console.log("Embedding length:", queryEmbedding?.length);
      console.log("First 5 values:", queryEmbedding?.slice(0,5));
    } catch (e) {
      console.warn("Embedding generation failed, using text-only search:", e.message);
      console.log("Question:", query);
      console.log("Embedding exists:", false);
      console.log("Embedding length:", 0);
      console.log("First 5 values:", []);
    }

    // 3. Retrieve from Postgres via RPCs
    // If no embedding, use a zero vector placeholder for FTS-only search
    const zeroEmbedding = '[' + Array(768).fill(0).join(',') + ']';

    const [memRes, emailRes, eventRes] = embeddingAvailable
      ? await Promise.all([
          supabaseAdmin.rpc('hybrid_search_memories', { query_text: query, query_embedding: `[${queryEmbedding.join(',')}]`, match_count: 30, p_user_id: userId }),
          supabaseAdmin.rpc('hybrid_search_emails', { query_text: query, query_embedding: `[${queryEmbedding.join(',')}]`, match_count: 20, p_user_id: userId }),
          supabaseAdmin.rpc('hybrid_search_events', { query_text: query, query_embedding: `[${queryEmbedding.join(',')}]`, match_count: 10, p_user_id: userId })
        ])
      : await Promise.all([
          supabaseAdmin.rpc('hybrid_search_memories', { query_text: query, query_embedding: zeroEmbedding, match_count: 30, p_user_id: userId }),
          supabaseAdmin.rpc('hybrid_search_emails', { query_text: query, query_embedding: zeroEmbedding, match_count: 20, p_user_id: userId }),
          supabaseAdmin.rpc('hybrid_search_events', { query_text: query, query_embedding: zeroEmbedding, match_count: 10, p_user_id: userId })
        ]);

    if (memRes.error) console.error("Memory search error", memRes.error);
    if (emailRes.error) console.error("Email search error", emailRes.error);
    if (eventRes.error) console.error("Event search error", eventRes.error);

    const memories = memRes.data || [];
    const emails = emailRes.data || [];
    const events = eventRes.data || [];

    // 4. Rank Results
    const rankedMemories = rankResults(memories, parsedQuery.intent, parsedQuery.entities);
    const rankedEmails = rankResults(emails, parsedQuery.intent, parsedQuery.entities);
    const rankedEvents = rankResults(events, parsedQuery.intent, parsedQuery.entities);

    const allRanked = [...rankedMemories, ...rankedEmails, ...rankedEvents];

    // 5. Assemble Context
    const assembled = assembleContext(allRanked, 2000, 0.3); // Drop below 0.3 score

    const latencyMs = Date.now() - startTime;

    // 6. Log Retrieval
    await supabaseAdmin.from('retrieval_logs').insert({
      user_id: userId,
      query,
      intent: parsedQuery.intent,
      entities: parsedQuery.entities,
      results_count: assembled.metadata.included,
      latency_ms: latencyMs
    });

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
      latencyMs
    }), { 
      status: 200, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (error: any) {
    console.error("Retrieve context error:", error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});
