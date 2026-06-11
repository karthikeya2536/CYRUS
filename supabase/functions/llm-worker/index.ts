import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";
import { encode } from "https://deno.land/std@0.177.0/encoding/hex.ts";
import { LLMRouter, supabaseAdmin } from "../_shared/llm-router.ts";
import { PROMPTS } from "../_shared/prompts.ts";

function normalizeKey(str: string) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
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

function ruleBasedExtraction(emails: any[], events: any[]) {
  const candidates: any[] = [];
  if (emails) {
    for (const email of emails) {
      const text = (email.subject + " " + email.snippet + " " + (email.body_text || "")).toLowerCase();
      if (email.system_importance > 0 && email.sender) {
        const match = email.sender.match(/^([^<]+)/);
        const name = match ? match[1].trim() : email.sender;
        if (name && name.length > 2 && name.length < 50) {
          candidates.push({
            category: 'person', content: name, source_type: 'email', source_id: email.gmail_message_id,
            confidence: Math.min(100, 70 + (email.system_importance * 30)), evidence: ['Found in sender'], source_excerpt: email.sender, expires_at: null, llm_importance: 0.5, system_importance: email.system_importance
          });
        }
      }
      const projectMatch = text.match(/(?:project|phase)\s+([a-z0-9]+)/i);
      if (projectMatch) {
        candidates.push({
          category: 'project', content: `Project ${projectMatch[1].toUpperCase()}`, source_type: 'email', source_id: email.gmail_message_id,
          confidence: 80, evidence: ['Pattern match'], source_excerpt: projectMatch[0], expires_at: null, llm_importance: 0.5, system_importance: 0.5
        });
      }
    }
  }
  return candidates;
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
  
  const { data: emails } = await supabaseAdmin.from("emails").select("*").eq("user_id", user_id).order("received_at", { ascending: false }).limit(50);
  const { data: events } = await supabaseAdmin.from("calendar_events").select("*").eq("user_id", user_id).gte("start_time", new Date().toISOString()).limit(50);

  const emailPayload = (emails || []).map(e => `ID:${e.gmail_message_id}\nFrom:${e.sender}\nSubj:${e.subject}\nBody:${e.snippet}`).join('\n---\n');
  const eventPayload = (events || []).map(e => `ID:${e.google_event_id}\nTitle:${e.title}\nTime:${e.start_time}`).join('\n---\n');

  let memoriesToVerify: any[] = [];
  let extractorProvider = '';

  const extractResult = await LLMRouter.execute({
    systemPrompt: PROMPTS.MEMORY_EXTRACTION_SYSTEM,
    userPrompt: `Emails:\n${emailPayload}\n\nEvents:\n${eventPayload}`,
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
      console.error("Failed to parse extractor JSON, falling back to rules", e);
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
    let finalExpiresAt = mem.expires_at || null;
    let finalLlmImportance = mem.llm_importance !== undefined ? mem.llm_importance : 0.5;
    
    let finalSystemImportance = mem.system_importance !== undefined ? mem.system_importance : 0.5;
    if (mem.system_importance === undefined && extractorProvider !== 'rule-engine') {
      if (mem.category === 'deadline' || mem.category === 'commitment') finalSystemImportance = 0.9;
      else if (mem.category === 'project') finalSystemImportance = 0.8;
      else if (mem.category === 'person') finalSystemImportance = 0.7;
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
          console.error("Failed to parse verifier JSON", e);
          finalDecision = 'APPROVE';
        }
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
            expires_at: finalExpiresAt || existing.expires_at
          }).eq("id", existing.id);
          updated++;
        }
      } else {
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
          llm_importance: finalLlmImportance,
          system_importance: finalSystemImportance
        }).select('id').single();

        if (!memErr && newMem) {
          inserted++;
          await supabaseAdmin.from("llm_jobs").insert({
            user_id,
            job_type: "generate_embedding",
            priority: 3,
            payload: { table: "memory_records", id: newMem.id, content: `${mem.category}: ${finalContent}` }
          });
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

async function processBriefingGeneration(job: any) {
  const user_id = job.user_id;

  const { data: emails } = await supabaseAdmin
    .from("emails")
    .select("*")
    .eq("user_id", user_id)
    .gt("system_importance", 0.0)
    .order("system_importance", { ascending: false })
    .limit(10);

  const now = new Date().toISOString();
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events } = await supabaseAdmin
    .from("calendar_events")
    .select("*")
    .eq("user_id", user_id)
    .gte("start_time", now)
    .lte("start_time", sevenDaysFromNow)
    .order("start_time", { ascending: true })
    .limit(10);

  const { data: memories } = await supabaseAdmin
    .from("memory_records")
    .select("*")
    .eq("user_id", user_id)
    .eq("active", true)
    .order("confidence_score", { ascending: false })
    .limit(20);

  const emailPayload = (emails || []).map(e => `From:${e.sender}\nSubj:${e.subject}\nBody:${e.snippet}`).join('\n---\n');
  const eventPayload = (events || []).map(e => `Title:${e.title}\nTime:${e.start_time}`).join('\n---\n');
  const memoryPayload = (memories || []).map(m => `[${m.category}] ${m.content} (Conf: ${m.confidence_score})`).join('\n');

  let finalBriefing = "";
  let generatorProvider = "rule-engine";
  let verifierProvider = "rule-engine";
  const generation_metadata: any = { latency: {} };

  const draftResult = await LLMRouter.execute({
    systemPrompt: PROMPTS.BRIEFING_DRAFT_SYSTEM,
    userPrompt: `Emails:\n${emailPayload}\n\nEvents:\n${eventPayload}\n\nMemories:\n${memoryPayload}`
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
        console.error("Verifier JSON parse failed", e);
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
  // This endpoint can be hit by pg_cron or manually
  try {
    // 1. Fetch one pending job
    const { data: jobs, error: fetchErr } = await supabaseAdmin
      .from("llm_jobs")
      .select("*")
      .eq("status", "pending")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(1);

    if (fetchErr) throw fetchErr;
    if (!jobs || jobs.length === 0) {
      return new Response("No pending jobs", { status: 200 });
    }

    const job = jobs[0];

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
      return new Response("Job taken by another worker", { status: 200 });
    }

    let resultData = null;

    try {
      if (updatedJob.job_type === "memory_extraction") {
        resultData = await processMemoryExtraction(updatedJob);
      } else if (updatedJob.job_type === "briefing_generation") {
        resultData = await processBriefingGeneration(updatedJob);
      } else if (updatedJob.job_type === "generate_embedding") {
        resultData = await processGenerateEmbedding(updatedJob);
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

      return new Response(JSON.stringify({ success: true, job_id: updatedJob.id }), { status: 200 });

    } catch (jobErr: any) {
      console.error(`Error processing job ${updatedJob.id}:`, jobErr);
      
      const isPermanent = updatedJob.attempts >= updatedJob.max_attempts;
      
      await supabaseAdmin
        .from("llm_jobs")
        .update({
          status: isPermanent ? "permanently_failed" : "pending",
          last_error: jobErr.message || String(jobErr),
          result: { error: jobErr.message || String(jobErr) }
        })
        .eq("id", updatedJob.id);

      return new Response(JSON.stringify({ error: jobErr.message }), { status: 500 });
    }

  } catch (err: any) {
    console.error("Worker Error:", err);
    return new Response(`Internal error: ${err.message}`, { status: 500 });
  }
});
