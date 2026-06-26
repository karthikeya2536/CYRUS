import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";
import { encode } from "https://deno.land/std@0.177.0/encoding/hex.ts";
import { LLMRouter, supabaseAdmin } from "../_shared/llm-router.ts";
import { PROMPTS } from "../_shared/prompts.ts";
import { getUserPlan, PLAN_LIMITS } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";
import { withTraceContext, startSpan, sendBufferedSpans } from "../_shared/trace.ts";

// Hard cap on how many jobs a single worker invocation will process, so one run
// can never loop unbounded. The worker is invoked repeatedly by the scheduler.
const MAX_JOBS_PER_RUN = 5;

// Phase 14 dedup: cosine-distance threshold (0 = identical). A candidate within
// this distance of an existing same-category memory is sent to LLM adjudication.
// Configurable via env; defaults to 0.15 (very similar).
const DEDUP_DISTANCE_THRESHOLD = parseFloat(Deno.env.get("DEDUP_DISTANCE_THRESHOLD") ?? "0.15");

// Feature Flags for Phase 034
const GRAPH_BUILD_ENABLED = Deno.env.get("GRAPH_BUILD_ENABLED") !== "false";


// Phase 16: lightweight, deterministic entity extraction for the retrieval
// graph. Pulls capitalized proper-noun-like tokens/phrases from memory content.
const ENTITY_STOPWORDS = new Set(["The", "A", "An", "This", "That", "These", "Those", "I", "You", "We", "They", "It", "Project"]);
function extractEntities(text: string): string[] {
  const out = new Set<string>();
  const matches = text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g) || [];
  for (const m of matches) {
    const t = m.trim();
    if (t.length >= 2 && !ENTITY_STOPWORDS.has(t)) out.add(t);
    if (out.size >= 10) break;
  }
  return [...out];
}

// Module-level logger for processing helpers (no request scope available there).
const workerLog = createLogger("llm-worker", "worker");

const MAX_JOBS_PER_BATCH = 50;

const GRAPH_STOP_ENTITIES = new Set([
  "user", "users", "person", "people", "professional", "speaker", "individual", 
  "contact", "email", "document", "resource", "project", "task", "event", 
  "meeting", "communication", "communication_thread", "platform", "organization", 
  "company", "group", "role", "domain", "technology", "skill", "date", 
  "artifact", "location", "application", "process"
]);

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function sha256(message: string) {
  const msgUint8 = new TextEncoder().encode(message.toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  return new TextDecoder().decode(encode(new Uint8Array(hashBuffer)));
}

function formatDate(dateString: string) {
  if (!dateString) return "Unknown time";
  const d = new Date(dateString);
  return d.toLocaleString("en-US", { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function ruleBasedExtraction(_emails: any[], _events: any[]) {
  return [];
}

// Deterministic memory lifecycle. expires_at is DERIVED from the category here,
// never trusted from the LLM, so memory expiry is consistent and auditable:
//   - event / meeting -> the event's end time (or start time); for email-sourced
//     items with no calendar row, the date the extractor parsed.
//   - deadline         -> the deadline date + 7 days of grace.
//   - commitment / preference / person / project / other -> null (durable).
// `eventById` maps a calendar event's google_event_id to its row so calendar-
// derived memories (whose source_id is that id) get the real event time.
function computeExpiresAt(mem: any, eventById: Map<string, any>): string | null {
  const category = String(mem.category || "").toLowerCase();
  if (category === "event" || category === "meeting") {
    const ev = mem.source_id ? eventById.get(String(mem.source_id)) : null;
    if (ev) return ev.end_time || ev.start_time || null;
    const d = mem.expires_at ? new Date(mem.expires_at) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (category === "deadline") {
    const d = mem.expires_at ? new Date(mem.expires_at) : null;
    if (d && !isNaN(d.getTime())) {
      return new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    return null;
  }
  return null;
}

// Raw, pre-grace deadline used purely as a ranking signal (urgency). Distinct
// from expires_at (lifecycle). For time-bound categories this is the LLM's /
// calendar's actual date; expires_at is always >= this (grace added in
// computeExpiresAt), so a deadline memory is never lifecycle-expired early.
function computeDeadlineAt(mem: any, eventById: Map<string, any>): string | null {
  const category = String(mem.category || "").toLowerCase();
  if (category === "event" || category === "meeting") {
    const ev = mem.source_id ? eventById.get(String(mem.source_id)) : null;
    if (ev) return ev.start_time || ev.end_time || null;
    const d = mem.expires_at ? new Date(mem.expires_at) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (category === "deadline") {
    const d = mem.expires_at ? new Date(mem.expires_at) : null;
    return d && !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

function ruleBasedBriefing(emails: any[], events: any[]) {
  let content = "## Today's Priorities\n";
  if (emails.length === 0 && events.length === 0) {
    content += "* You have no urgent emails or upcoming meetings. Enjoy your day!\n";
  } else {
    if (events.length > 0) {
      content += `* **Prepare for upcoming meeting:** ${events[0].title} at ${formatDate(events[0].start_time)}.\n`;
    }
    if (emails.length > 0) {
      const topEmail = emails[0];
      content += `* **Respond to high-priority email:** "${topEmail.subject}" from ${topEmail.sender}.\n`;
    }
  }
  content += "\n## Important Emails\n";
  emails.forEach(e => content += `* **${e.sender}**: ${e.subject}\n`);
  content += "\n## Upcoming Meetings\n";
  events.forEach(e => content += `* **${e.title}** at ${formatDate(e.start_time)}\n`);
  return content;
}

async function processMemoryExtraction(job: any) {
  const user_id = job.user_id;
  
  const { data: emails, error: emailsError } = await supabaseAdmin.from("emails").select("*").eq("user_id", user_id).order("received_at", { ascending: false }).limit(10);
  if (emailsError) throw emailsError;
  // Only near-term events feed memory extraction. Without an upper bound,
  // recurring/annual events (birthdays years out) get ingested as permanent
  // memories. 30 days keeps extraction to actionable horizon.
  const extractionNow = new Date().toISOString();
  const extractionWindowEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error: eventsError } = await supabaseAdmin.from("calendar_events").select("*").eq("user_id", user_id).gte("start_time", extractionNow).lte("start_time", extractionWindowEnd).limit(50);
  if (eventsError) throw eventsError;
  const { data: slackMessages, error: slackError } = await supabaseAdmin.from("slack_messages").select("*").eq("user_id", user_id).order("posted_at", { ascending: false }).limit(50);
  if (slackError) throw slackError;
  const { data: notionPages, error: notionError } = await supabaseAdmin.from("notion_pages").select("*").eq("user_id", user_id).order("last_edited_at", { ascending: false }).limit(50);
  if (notionError) throw notionError;

  const emailPayload = (emails || []).map(e => `ID:${e.gmail_message_id}\nFrom:${e.sender}\nSubj:${e.subject}\nBody:${e.snippet}`).join('\n---\n');
  const eventPayload = (events || []).map(e => `ID:${e.google_event_id}\nTitle:${e.title}\nTime:${e.start_time}`).join('\n---\n');
  // Index events by their google_event_id so calendar-derived memories can be
  // expired at the real event time (see computeExpiresAt).
  const eventById = new Map<string, any>();
  for (const e of (events || [])) {
    if (e.google_event_id) eventById.set(String(e.google_event_id), e);
  }
  const slackPayload = (slackMessages || []).map(m => `ID:${m.slack_ts}\nChannel:${m.channel_name || m.channel_id}\nAuthor:${m.author}\nText:${m.text}`).join('\n---\n');
  const notionPayload = (notionPages || []).map(p => `ID:${p.notion_page_id}\nTitle:${p.title}\nContent:${p.content}`).join('\n---\n');

  // Plan storage cap: stop inserting new memories past the plan's limit.
  const plan = await getUserPlan(supabaseAdmin, user_id);
  const memoryCap = PLAN_LIMITS[plan].memoryRecordsMax;
  let memoryCount = 0;
  if (memoryCap !== null) {
    const { count } = await supabaseAdmin
      .from("memory_records")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id);
    memoryCount = count || 0;
  }

  let memoriesToVerify: any[] = [];
  let extractorProvider = '';

  const extractResult = await LLMRouter.execute({
    systemPrompt: PROMPTS.MEMORY_EXTRACTION_SYSTEM,
    userPrompt: `Emails:\n${emailPayload}\n\nEvents:\n${eventPayload}\n\nSlack Messages:\n${slackPayload}\n\nNotion Pages:\n${notionPayload}`,
    expectedFormat: 'json'
  });

  extractorProvider = extractResult.provider;

  if (extractorProvider === 'rule-engine') {
    memoriesToVerify = ruleBasedExtraction(emails || [], events || []);
  } else {
    try {
      let jsonStr = extractResult.content;
      const match = jsonStr.match(/\[.*\]/s);
      if (match) jsonStr = match[0];
      memoriesToVerify = JSON.parse(jsonStr);
    } catch (e) {
      workerLog.warn("extractor_json_parse_failed_fallback_rules");
      memoriesToVerify = ruleBasedExtraction(emails || [], events || []);
      extractorProvider = 'rule-engine';
    }
  }

  let inserted = 0;
  let updated = 0;
  const resultData: any = { latency: { extract: extractResult.latencyMs }, verifications: [] };

  for (const mem of memoriesToVerify) {
    if (mem.confidence < 70 && extractorProvider !== 'rule-engine') continue;

    let finalDecision = extractorProvider === 'rule-engine' ? 'APPROVE' : 'REJECT';
    let verifierProvider = 'rule-engine';
    let finalContent = mem.content;
    let finalConfidence = mem.confidence;
    let verifierReasoning = "";
    const finalExpiresAt = computeExpiresAt(mem, eventById);
    const finalDeadlineAt = computeDeadlineAt(mem, eventById);
    let finalLlmImportance = mem.llm_importance !== undefined ? mem.llm_importance : 0.5;
    
    let finalSystemImportance = mem.system_importance !== undefined ? mem.system_importance : 0.5;
    if (mem.system_importance === undefined && extractorProvider !== 'rule-engine') {
      if (mem.category === 'deadline' || mem.category === 'commitment') finalSystemImportance = 0.9;
      else if (mem.category === 'project') finalSystemImportance = 0.8;
      else if (mem.category === 'person') finalSystemImportance = 0.7;
      else if (mem.category === 'meeting' || mem.category === 'event') finalSystemImportance = 0.7;
      else if (mem.category === 'preference') finalSystemImportance = 0.6;
    }

    if (extractorProvider !== 'rule-engine') {
      const verifyResult = await LLMRouter.execute({
        systemPrompt: PROMPTS.MEMORY_VERIFICATION_SYSTEM,
        userPrompt: `Source ID: ${mem.source_id}\nSource Excerpt: ${mem.source_excerpt}\nExtracted Memory: ${JSON.stringify(mem, null, 2)}`,
        expectedFormat: 'json'
      }, [extractorProvider]);

      verifierProvider = verifyResult.provider;

      if (verifierProvider === 'rule-engine') {
        finalDecision = 'APPROVE';
      } else {
        try {
          let vStr = verifyResult.content;
          const vMatch = vStr.match(/\{.*\}/s);
          if (vMatch) vStr = vMatch[0];
          const vData = JSON.parse(vStr);
          verifierReasoning = vData.reasoning || "";

          finalDecision = vData.decision;
          if (vData.decision === 'MODIFIED') {
            finalContent = vData.content || finalContent;
          }
          finalConfidence = vData.verification_score || finalConfidence;

          if (finalDecision === 'UNCERTAIN') {
            const tieResult = await LLMRouter.execute({
              systemPrompt: PROMPTS.MEMORY_TIEBREAKER_SYSTEM,
              userPrompt: `Source Excerpt: ${mem.source_excerpt}\nExtracted: ${JSON.stringify(mem)}\nVerifier Reasoning: ${vData.reasoning}`,
              expectedFormat: 'json'
            }, [extractorProvider, verifierProvider]);

            const tbProvider = tieResult.provider;
            verifierProvider = `${verifierProvider} + ${tbProvider} (TB)`;

            if (tbProvider === 'rule-engine') {
              finalDecision = 'APPROVE';
            } else {
              try {
                let tStr = tieResult.content;
                const tMatch = tStr.match(/\{.*\}/s);
                if (tMatch) tStr = tMatch[0];
                const tData = JSON.parse(tStr);
                finalDecision = tData.decision;
              } catch (e) {
                finalDecision = 'APPROVE';
              }
            }
          }
        } catch (e) {
          // Fail closed: an unparseable verifier response must not silently
          // admit an unverified memory. Reject rather than approve.
          workerLog.warn("verifier_json_parse_failed");
          finalDecision = 'REJECT';
        }
      }
    }

    if (typeof finalContent !== "string") {
      finalContent = (finalContent as any)?.content ?? "";
    }

    if (!finalContent || typeof finalContent !== 'string' || !finalContent.trim()) {
      finalDecision = 'REJECT';
      finalContent = "";
    } else {
      try {
        const parsed = JSON.parse(finalContent);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.content === "string"
        ) {
          finalContent = parsed.content;
        }
      } catch {}
    }

    if (
      finalContent.includes('"category"') &&
      finalContent.includes('"confidence"')
    ) {
      finalDecision = 'REJECT';
    }

    if (finalDecision === 'APPROVE' || finalDecision === 'MODIFIED') {
      const isOnlyName = /^[A-Z][a-z]+(\s[A-Z][a-z]+)+$/.test(finalContent.trim());
      
      if (
        finalContent.length < 8 ||
        isOnlyName ||
        finalContent.trim().startsWith("{") ||
        finalConfidence < 70 ||
        (verifierReasoning && finalContent === verifierReasoning)
      ) {
        finalDecision = 'REJECT';
      }
    }

    resultData.verifications.push({ memory: mem.content, decision: finalDecision, verifier: verifierProvider });

    await supabaseAdmin.from('memory_extraction_logs').insert({
      source_id: mem.source_id || 'unknown',
      extractor_provider: extractorProvider,
      verifier_provider: verifierProvider,
      decision: finalDecision,
      confidence: finalConfidence
    });

    if (finalDecision === 'APPROVE' || finalDecision === 'MODIFIED') {
      const memory_key = normalizeKey(`${mem.category}_${finalContent}`);
      const source_hash = await sha256(finalContent);

      const { data: existing } = await supabaseAdmin
        .from("memory_records")
        .select("*")
        .eq("user_id", user_id)
        .eq("category", mem.category)
        .eq("memory_key", memory_key)
        .single();

      if (existing) {
        if (existing.source_hash !== source_hash) {
          await supabaseAdmin.from("memory_records").update({
            occurrence_count: existing.occurrence_count + 1,
            confidence_score: Math.min(100, existing.confidence_score + 5),
            last_seen_at: new Date().toISOString(),
            expires_at: finalExpiresAt || existing.expires_at,
            deadline_at: finalDeadlineAt
          }).eq("id", existing.id);
          updated++;
          if (GRAPH_BUILD_ENABLED) {
            await supabaseAdmin.from("llm_jobs").insert({
              user_id,
              job_type: "graph_construction",
              priority: 4,
              payload: { memory_id: existing.id, content: finalContent, expires_at: finalExpiresAt }
            });
          }
        }
      } else {
        // Enforce plan storage cap on new memories (updates above are exempt).
        if (memoryCap !== null && memoryCount >= memoryCap) {
          continue;
        }

        // ---- Phase 14: safe semantic de-duplication ----
        // Embed the candidate, then search the SAME category for near matches.
        // If the LLM confirms a duplicate, merge into the canonical row
        // (increment only, never overwrite) and record an audit row. Never
        // deletes, never overwrites, never crosses categories.
        let dedupEmbedding: number[] | null = null;
        try {
          const emb = await LLMRouter.generateEmbedding(`${mem.category}: ${finalContent}`);
          if (Array.isArray(emb) && emb.length > 0) dedupEmbedding = emb;
        } catch (_e) {
          workerLog.warn("dedup_embedding_failed");
        }

        let merged = false;
        if (dedupEmbedding) {
          try {
            const { data: candidates } = await supabaseAdmin.rpc("match_memory_candidates", {
              p_user_id: user_id,
              p_category: mem.category,
              query_embedding: `[${dedupEmbedding.join(",")}]`,
              match_count: 5,
            });
            const top = (candidates || []).find((c: any) => c.distance <= DEDUP_DISTANCE_THRESHOLD);
            if (top) {
              let isDuplicate = false;
              let adjudicator = "threshold";
              const adj = await LLMRouter.execute({
                systemPrompt: PROMPTS.MEMORY_DEDUP_SYSTEM,
                userPrompt: `Category: ${mem.category}\nExisting memory: "${top.content}"\nNew candidate: "${finalContent}"`,
                expectedFormat: "json",
              });
              adjudicator = adj.provider;
              if (adj.provider === "rule-engine") {
                // No LLM available: fall back to the distance threshold alone.
                isDuplicate = true;
              } else {
                try {
                  const m = adj.content.match(/\{.*\}/s);
                  const j = JSON.parse(m ? m[0] : adj.content);
                  isDuplicate = j.is_duplicate === true;
                } catch (_e) {
                  isDuplicate = false;
                }
              }

              if (isDuplicate) {
                // Merge: increment the canonical row only.
                await supabaseAdmin.from("memory_records").update({
                  occurrence_count: top.occurrence_count + 1,
                  confidence_score: Math.min(100, top.confidence_score + 5),
                  last_seen_at: new Date().toISOString(),
                  deadline_at: finalDeadlineAt,
                }).eq("id", top.id);
                await supabaseAdmin.from("memory_merge_audit").insert({
                  user_id,
                  canonical_id: top.id,
                  category: mem.category,
                  duplicate_content: finalContent,
                  duplicate_source_id: mem.source_id || "unknown",
                  similarity_distance: top.distance,
                  decision: "merged",
                  adjudicator,
                });
                merged = true;
                updated++;
                if (GRAPH_BUILD_ENABLED) {
                  await supabaseAdmin.from("llm_jobs").insert({
                    user_id,
                    job_type: "graph_construction",
                    priority: 4,
                    payload: { memory_id: top.id, content: finalContent, expires_at: finalExpiresAt }
                  });
                }
              }
            }
          } catch (_e) {
            workerLog.warn("dedup_candidate_search_failed");
          }
        }

        if (!merged) {
          const { data: newMem, error: memErr } = await supabaseAdmin.from("memory_records").insert({
            user_id,
            category: mem.category,
            content: finalContent,
            memory_key,
            source_type: mem.source_type || 'unknown',
            source_id: mem.source_id || 'unknown',
            source_hash,
            confidence_score: finalConfidence,
            llm_provider: extractorProvider,
            verifier_provider: verifierProvider,
            verified: true,
            verification_score: finalConfidence,
            evidence: mem.evidence || [],
            source_excerpt: mem.source_excerpt || '',
            expires_at: finalExpiresAt,
            deadline_at: finalDeadlineAt,
            llm_importance: finalLlmImportance,
            system_importance: finalSystemImportance,
            // Reuse the embedding we already computed for dedup when available,
            // avoiding a second embedding job.
            ...(dedupEmbedding ? { embedding: dedupEmbedding } : {}),
          }).select('id').single();

          if (memErr) {
            console.error("memory_insert_failed", memErr);
            throw memErr;
          }

          if (newMem) {
            inserted++;
            memoryCount++;
            // Phase 16: record entity mentions for graph traversal (best-effort).
            const entities = extractEntities(finalContent);
            if (entities.length) {
              await supabaseAdmin.from("entity_mentions")
                .upsert(
                  entities.map((e) => ({ user_id, memory_id: newMem.id, entity: e })),
                  { onConflict: "user_id,memory_id,entity", ignoreDuplicates: true },
                );
            }
            // Only enqueue an embedding job if we could not embed inline.
            if (!dedupEmbedding) {
              await supabaseAdmin.from("llm_jobs").insert({
                user_id,
                job_type: "generate_embedding",
                priority: 3,
                payload: { table: "memory_records", id: newMem.id, content: `${mem.category}: ${finalContent}` }
              });
            }
            if (GRAPH_BUILD_ENABLED) {
              await supabaseAdmin.from("llm_jobs").insert({
                user_id,
                job_type: "graph_construction",
                priority: 4,
                payload: { memory_id: newMem.id, content: finalContent, expires_at: finalExpiresAt }
              });
            }
          }
        }
      }
    }
  }

  resultData.inserted = inserted;
  resultData.updated = updated;
  return resultData;
}

async function processGenerateEmbedding(job: any) {
  const { table, id, content } = job.payload;
  if (!table || !id || !content) {
    throw new Error("Missing table, id, or content in generate_embedding job");
  }

  const embedding = await LLMRouter.generateEmbedding(content);

  const { error } = await supabaseAdmin
    .from(table)
    .update({ embedding })
    .eq('id', id);

  if (error) throw error;

  return { success: true, table, id };
}

async function processGraphConstruction(job: any) {
  const { memory_id, content, expires_at } = job.payload;
  if (!memory_id || !content) {
    throw new Error("Missing memory_id or content in graph_construction job");
  }

  const result = await LLMRouter.execute({
    systemPrompt: PROMPTS.GRAPH_EXTRACTION_SYSTEM,
    userPrompt: `Memory Content: ${content}`,
    expectedFormat: "json"
  });

  let graphData;
  try {
    let jsonStr = result.content;
    const match = jsonStr.match(/\\{.*\\}/s);
    if (match) jsonStr = match[0];
    graphData = JSON.parse(jsonStr);
  } catch (e) {
    workerLog.warn("graph_extraction_json_parse_failed");
    return { success: false, reason: "parse_failed" };
  }

  const nodes = graphData.nodes || [];
  const edges = graphData.edges || [];
  let nodesCreated = 0;
  let edgesCreated = 0;
  const touchedNodeIds = new Set<string>();

  for (const node of nodes) {
    if (!node.id || !node.type) continue;
    const nodeKey = normalizeKey(node.id);
    const isStopEntity = GRAPH_STOP_ENTITIES.has(nodeKey);
    const { data: nData } = await supabaseAdmin.from("graph_nodes").upsert(
      { user_id: job.user_id, node_key: nodeKey, node_type: node.type, is_stop_entity: isStopEntity },
      { onConflict: "user_id,node_key" }
    ).select("id").single();
    
    if (nData) {
      nodesCreated++;
      touchedNodeIds.add(nData.id);
      await supabaseAdmin.from("graph_node_members").upsert(
        { node_id: nData.id, memory_id },
        { onConflict: "node_id,memory_id" }
      );
      
      if (node.original_id) {
        const originalKey = normalizeKey(node.original_id);
        if (originalKey !== nodeKey) {
          await supabaseAdmin.from("graph_merge_audit").insert({
            user_id: job.user_id,
            source_node_key: originalKey,
            target_node_key: nodeKey,
            reason: "LLM Canonical Merge",
            confidence: 1.0
          });
        }
      }
    }
  }

  for (const edge of edges) {
    if (!edge.source || !edge.target || !edge.relationship || edge.confidence < 0.30) continue;
    
    // Resolve nodes
    const srcKey = normalizeKey(edge.source);
    const tgtKey = normalizeKey(edge.target);
    const { data: srcNode } = await supabaseAdmin.from("graph_nodes").select("id").eq("user_id", job.user_id).eq("node_key", srcKey).single();
    const { data: tgtNode } = await supabaseAdmin.from("graph_nodes").select("id").eq("user_id", job.user_id).eq("node_key", tgtKey).single();

    if (srcNode && tgtNode) {
      touchedNodeIds.add(srcNode.id);
      touchedNodeIds.add(tgtNode.id);
      const { data: edgeData } = await supabaseAdmin.from("graph_edges").upsert(
        { 
          user_id: job.user_id, 
          source_node_id: srcNode.id, 
          target_node_id: tgtNode.id, 
          relationship_type: edge.relationship,
          confidence: edge.confidence,
          expires_at: expires_at,
          last_evidence_at: new Date().toISOString()
        },
        { onConflict: "source_node_id,target_node_id,relationship_type" }
      ).select("id").single();

      if (edgeData) {
        edgesCreated++;
        await supabaseAdmin.from("edge_evidence").upsert(
          { edge_id: edgeData.id, memory_id, evidence_type: edge.evidence_type || "inferred" },
          { onConflict: "edge_id,memory_id" }
        );
      }
    }
  }

  if (touchedNodeIds.size > 0) {
    await supabaseAdmin.rpc("update_graph_node_scores", { node_ids: Array.from(touchedNodeIds) });
  }

  await supabaseAdmin.from("graph_build_audit").insert({
    user_id: job.user_id,
    memory_id,
    status: "success",
    nodes_created: nodesCreated,
    edges_created: edgesCreated
  });

  return { success: true, memory_id, nodesCreated, edgesCreated };
}

async function processBriefingGeneration(job: any) {
  const user_id = job.user_id;

  const { data: emails, error: emailsError } = await supabaseAdmin
    .from("emails")
    .select("*")
    .eq("user_id", user_id)
    .order("received_at", { ascending: false })
    .limit(10);
  if (emailsError) throw emailsError;

  const now = new Date().toISOString();
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rawEvents, error: eventsError } = await supabaseAdmin
    .from("calendar_events")
    .select("*")
    .eq("user_id", user_id)
    .gte("start_time", now)
    .lte("start_time", thirtyDaysFromNow)
    .order("start_time", { ascending: true })
    .limit(50);
  if (eventsError) throw eventsError;

  // Filter extended window (7-30 days) for important keywords only
  const importantKeywords = ["important", "high importance", "deadline", "exam", "interview", "meeting", "travel", "payment", "contract"];
  const events = (rawEvents || []).filter(e => {
    if (e.start_time <= sevenDaysFromNow) return true;
    const text = ((e.title || "") + " " + (e.description || "")).toLowerCase();
    return importantKeywords.some(kw => text.includes(kw));
  }).slice(0, 15);

  const { data: memories, error: memoriesError } = await supabaseAdmin
    .from("memory_records")
    .select("*")
    .eq("user_id", user_id)
    .eq("active", true)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order("confidence_score", { ascending: false })
    .limit(20);
  if (memoriesError) throw memoriesError;

  const { data: slackMessages, error: slackError } = await supabaseAdmin
    .from("slack_messages")
    .select("*")
    .eq("user_id", user_id)
    .order("posted_at", { ascending: false })
    .limit(10);
  if (slackError) throw slackError;

  const { data: notionPages, error: notionError } = await supabaseAdmin
    .from("notion_pages")
    .select("*")
    .eq("user_id", user_id)
    .order("last_edited_at", { ascending: false })
    .limit(10);
  if (notionError) throw notionError;

  const emailPayload = (emails || []).map(e => `From:${e.sender}\nSubj:${e.subject}\nBody:${e.snippet}`).join('\n---\n');
  const eventPayload = (events || []).map(e => `Title:${e.title}\nTime:${e.start_time}`).join('\n---\n');
  const memoryPayload = (memories || []).map(m => `[${m.category}] ${m.content} (Conf: ${m.confidence_score})`).join('\n');
  const slackPayload = (slackMessages || []).map(m => `Channel:${m.channel_name || m.channel_id}\nAuthor:${m.author}\nText:${m.text}`).join('\n---\n');
  const notionPayload = (notionPages || []).map(p => `Title:${p.title}\nContent:${p.content}`).join('\n---\n');

  let finalBriefing = "";
  let generatorProvider = "rule-engine";
  let verifierProvider = "rule-engine";
  const generation_metadata: any = { latency: {} };

  // CACHE BUSTER: fix date grounding format for LLM
  const draftResult = await LLMRouter.execute({
    systemPrompt: PROMPTS.BRIEFING_DRAFT_SYSTEM,
    userPrompt: `Today's Date: ${now.split('T')[0]}\nCurrent Time: ${now}\n\nEmails:\n${emailPayload}\n\nEvents:\n${eventPayload}\n\nSlack Messages:\n${slackPayload}\n\nNotion Pages:\n${notionPayload}\n\nMemories:\n${memoryPayload}`
  });

  generatorProvider = draftResult.provider;
  generation_metadata.latency.draft = draftResult.latencyMs;

  if (generatorProvider === 'rule-engine') {
    finalBriefing = ruleBasedBriefing(emails || [], events || []);
  } else {
    const verifyResult = await LLMRouter.execute({
      systemPrompt: PROMPTS.BRIEFING_VERIFICATION_SYSTEM,
      userPrompt: `Draft Briefing:\n${draftResult.content}\n\nChecklist Review!`,
      expectedFormat: 'json'
    }, [generatorProvider]);

    verifierProvider = verifyResult.provider;
    generation_metadata.latency.verification = verifyResult.latencyMs;

    if (verifierProvider === 'rule-engine') {
      finalBriefing = draftResult.content;
    } else {
      try {
        let vStr = verifyResult.content;
        const match = vStr.match(/\{.*\}/s);
        if (match) vStr = match[0];
        const vData = JSON.parse(vStr);
        
        generation_metadata.checklist = vData.checklist;
        finalBriefing = vData.final_briefing_markdown || draftResult.content;
      } catch (e) {
        workerLog.warn("briefing_verifier_json_parse_failed");
        finalBriefing = draftResult.content;
      }
    }
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("briefings")
    .insert({
      user_id: user_id,
      content: finalBriefing,
      email_count_used: emails ? emails.length : 0,
      event_count_used: events ? events.length : 0,
      generator_provider: generatorProvider,
      verifier_provider: verifierProvider,
      generation_metadata: generation_metadata
    })
    .select("*")
    .single();

  if (insertError) {
    throw insertError;
  }

  return { briefing_id: inserted.id, generatorProvider, verifierProvider, metadata: generation_metadata };
}

serve(async (req: Request) => {
  // Worker is invoked by pg_cron / trusted schedulers only — require a shared secret.
  const workerSecret = Deno.env.get("WORKER_SECRET");
  if (!workerSecret || req.headers.get("x-worker-secret") !== workerSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const requestId = newRequestId();
  const log = createLogger("llm-worker", requestId);

  try {
    // 0. Reclaim jobs stuck in "processing" from a crashed/timed-out worker.
    //    A job killed by the function timeout never reaches the catch block, so
    //    its dead-letter check must also run here. attempts is incremented at
    //    claim time, so a job that exhausted max_attempts is dead-lettered;
    //    otherwise it is requeued. Without this, a job that always times out is
    //    reclaimed forever and never dead-letters.
    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: staleJobs } = await supabaseAdmin
      .from("llm_jobs")
      .select("id, attempts, max_attempts")
      .eq("status", "processing")
      .lt("started_at", staleCutoff);

    if (staleJobs && staleJobs.length > 0) {
      const deadIds = staleJobs.filter((j: any) => j.attempts >= j.max_attempts).map((j: any) => j.id);
      const requeueIds = staleJobs.filter((j: any) => j.attempts < j.max_attempts).map((j: any) => j.id);

      if (deadIds.length > 0) {
        await supabaseAdmin
          .from("llm_jobs")
          .update({ status: "permanently_failed", last_error: "Reclaimed after timeout; max attempts exhausted." })
          .in("id", deadIds);
      }
      if (requeueIds.length > 0) {
        await supabaseAdmin
          .from("llm_jobs")
          .update({ status: "pending" })
          .in("id", requeueIds);
      }
    }

    let processed = 0;
    const completed: string[] = [];
    const seen: string[] = [];

    while (processed < MAX_JOBS_PER_RUN) {
      // 1. Fetch one pending job, skipping any already touched this run so a
      //    failed/re-queued job can't be re-selected ahead of other jobs.
      let query = supabaseAdmin
        .from("llm_jobs")
        .select("*")
        .eq("status", "pending");
      if (seen.length > 0) {
        query = query.not("id", "in", `(${seen.join(",")})`);
      }
      const { data: jobs, error: fetchErr } = await query
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(1);

      if (fetchErr) throw fetchErr;
      if (!jobs || jobs.length === 0) break;

      const job = jobs[0];
      seen.push(job.id);

      // 2. Mark as processing (optimistic locking)
      const { data: updatedJob, error: updateErr } = await supabaseAdmin
        .from("llm_jobs")
        .update({
          status: "processing",
          started_at: new Date().toISOString(),
          attempts: job.attempts + 1
        })
        .eq("id", job.id)
        .eq("status", "pending")
        .select()
        .single();

      if (updateErr || !updatedJob) {
        // Job was taken by another worker; try the next one.
        continue;
      }

      processed++;
      // Continue the request_id chain from the enqueuing function when present.
      const jobRequestId = updatedJob.payload?.request_id || requestId;
      const jobTraceId = updatedJob.trace_id || crypto.randomUUID();
      const jobLog = createLogger("llm-worker", jobRequestId);

      try {
        await withTraceContext({ trace_id: jobTraceId, span_id: crypto.randomUUID() }, async () => {
          const workerSpan = startSpan("llm-worker", "process_job", {
            span_kind: "server",
            job_id: updatedJob.id,
            user_id: updatedJob.user_id,
          });
          
          try {
            let resultData = null;
            if (updatedJob.job_type === "memory_extraction") {
              resultData = await processMemoryExtraction(updatedJob);
            } else if (updatedJob.job_type === "briefing_generation") {
              resultData = await processBriefingGeneration(updatedJob);
            } else if (updatedJob.job_type === "generate_embedding") {
              resultData = await processGenerateEmbedding(updatedJob);
            } else if (updatedJob.job_type === "graph_construction") {
              resultData = await processGraphConstruction(updatedJob);
            } else {
              throw new Error(`Unknown job type: ${updatedJob.job_type}`);
            }

            // 3. Mark completed
            await supabaseAdmin
              .from("llm_jobs")
              .update({
                status: "completed",
                completed_at: new Date().toISOString(),
                result: resultData
              })
              .eq("id", updatedJob.id);

            completed.push(updatedJob.id);
            workerSpan.setStatus("ok");
          } catch (err) {
            workerSpan.setStatus("error", String(err));
            throw err;
          } finally {
            workerSpan.end();
            await sendBufferedSpans(supabaseAdmin);
          }
        });

      } catch (jobErr: any) {
        jobLog.error("job_processing_failed", { job_id: updatedJob.id, job_type: updatedJob.job_type });

        // Dead-letter once attempts exhaust max_attempts; otherwise re-queue.
        const isPermanent = updatedJob.attempts >= updatedJob.max_attempts;

        await supabaseAdmin
          .from("llm_jobs")
          .update({
            status: isPermanent ? "permanently_failed" : "pending",
            last_error: jobErr.message || String(jobErr),
            result: { error: jobErr.message || String(jobErr) }
          })
          .eq("id", updatedJob.id);

        if (isPermanent) {
          jobLog.error("job_dead_lettered", { job_id: updatedJob.id });
        }
        // Isolate the failure: skip to the next job instead of aborting the
        // whole run. The failed job is excluded via `seen`, so it won't be
        // re-selected this run.
        continue;
      }
    }

    if (processed === 0) {
      return new Response("No pending jobs", { status: 200 });
    }

    return new Response(JSON.stringify({ success: true, processed, completed }), { status: 200 });

  } catch (_err: any) {
    log.error("worker_error");
    return new Response("Internal server error", { status: 500 });
  }
});
