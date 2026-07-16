import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 10;

// Helper to decode base64url string
function decodeBase64Url(str: string) {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  } catch (e) {
    return "";
  }
}

// Helper to extract body from Gmail message payload
function getMessageBody(payload: any): string {
  if (!payload) return "";

  // If there are parts, look for text/plain
  if (payload.parts && payload.parts.length > 0) {
    let body = "";
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += decodeBase64Url(part.body.data);
      } else if (part.parts) {
        // Recursive check for nested multipart
        body += getMessageBody(part);
      }
    }
    if (body) return body;

    // Fallback to text/html if no text/plain found
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        body += decodeBase64Url(part.body.data);
      }
    }
    return body;
  }

  // If there's no parts, the body might be directly in payload.body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("gmail-sync", requestId);

  function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let userId: string | null = null;
  let supabaseAdmin: any = null;

  // TD-001: persist sync failures on the account so a silently failing scheduled
  // sync is visible. markBroken=true only for token/auth failures that require a
  // reconnect; transient API errors are recorded WITHOUT flipping status so the
  // scheduled sync (which only targets status='active') keeps retrying.
  async function recordSyncError(message: string, markBroken = false) {
    if (!supabaseAdmin || !userId) return;
    try {
      const patch: Record<string, unknown> = {
        last_sync_error: message.slice(0, 500),
        last_sync_error_at: new Date().toISOString(),
      };
      if (markBroken) patch.status = "broken";
      await supabaseAdmin
        .from("connected_accounts")
        .update(patch)
        .eq("user_id", userId)
        .eq("provider", "google");
    } catch (_e) {
      log.warn("record_sync_error_failed");
    }
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

    if (!googleClientId || !googleClientSecret) {
      return jsonResponse({ error: "Missing Google OAuth credentials." }, 500);
    }

    supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Resolve the target user. Two authenticated invocation paths:
    //   1. System (pg_cron -> pg_net): x-worker-secret header matches
    //      WORKER_SECRET; the target user_id is supplied in the request body.
    //      Same secret/header pattern as llm-worker. No rate limit here.
    //   2. User request: caller's JWT is validated via getUser() (anon client),
    //      then rate-limited per user. Sync logic below is identical for both.
    const workerSecret = req.headers.get("x-worker-secret");
    const expectedWorkerSecret = Deno.env.get("WORKER_SECRET");

    if (workerSecret && expectedWorkerSecret && workerSecret === expectedWorkerSecret) {
      let body: { user_id?: string } = {};
      try {
        body = await req.json();
      } catch (_e) { /* empty/invalid body falls through to the check below */ }
      if (!body?.user_id) {
        return jsonResponse({ error: "Missing user_id for system invocation." }, 400);
      }
      userId = body.user_id;
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return jsonResponse({ error: "Missing authorization header" }, 401);
      }

      const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
      if (userError || !user) {
        return jsonResponse({ error: "Invalid user token" }, 401);
      }

      const rl = await checkRateLimit(supabaseAdmin, user.id, "gmail-sync", RATE_LIMIT_PER_MIN);
      if (rl.limited) {
        return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
      }

      userId = user.id;
    }

    // Get integration secrets
    const { data: secretData, error: secretErr } = await supabaseAdmin
      .from("integration_secrets")
      .select("*")
      .eq("user_id", userId)
      .eq("provider", "google")
      .single();

    if (secretErr || !secretData) {
      return jsonResponse({ error: "Google connection not found." }, 404);
    }

    let accessToken = secretData.access_token;
    let isExpired = false;

    if (secretData.token_expires_at) {
      const expiresAt = new Date(secretData.token_expires_at).getTime();
      // Add 1 minute buffer
      if (Date.now() > expiresAt - 60000) {
        isExpired = true;
      }
    }

    // Refresh token logic
    if (isExpired || !accessToken) {
      if (!secretData.refresh_token) {
        log.warn("TOKEN_REFRESH_FAILED");
        await recordSyncError("Token expired and no refresh token available. Reconnect required.", true);
        return jsonResponse({ error: "Token expired and no refresh token available. Reconnect required." }, 401);
      }

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: googleClientId,
          client_secret: googleClientSecret,
          refresh_token: secretData.refresh_token,
          grant_type: "refresh_token",
        }),
      });

      let tokenData;
      try {
        tokenData = await tokenResponse.json();
      } catch (_e) {
        log.warn("TOKEN_REFRESH_FAILED");
        await recordSyncError("Token refresh failed: unparseable response from Google.", true);
        return jsonResponse({ error: "Refresh failed: Unparseable response from Google." }, 401);
      }

      if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
        log.warn("TOKEN_REFRESH_FAILED");
        await recordSyncError(`Token refresh failed: ${tokenData.error_description || tokenData.error || "missing access token"}`, true);
        return jsonResponse({ error: `Refresh failed: ${tokenData.error_description || tokenData.error || "Missing access token"}` }, 401);
      }

      accessToken = tokenData.access_token;
      const tokenExpiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : null;

      // Update secrets with new access token. If this write fails we must NOT
      // continue as if connected: mark the account broken and abort so the
      // account is never left "active" with a stale/unwritten token.
      const { error: secretUpdateErr } = await supabaseAdmin
        .from("integration_secrets")
        .update({
          access_token: accessToken,
          token_expires_at: tokenExpiresAt,
          updated_at: new Date().toISOString()
        })
        .eq('id', secretData.id);

      if (secretUpdateErr) {
        log.error("TOKEN_PERSIST_FAILED");
        await recordSyncError("Failed to persist refreshed token.", true);
        return jsonResponse({ error: "Failed to persist refreshed token." }, 500);
      }

      log.info("TOKEN_REFRESHED");
    } else {
      log.info("TOKEN_VALID");
    }

    // Call Gmail API
    // Call Gmail API with pagination
    let allMessages: any[] = [];
    let pageToken: string | undefined;
    do {
      const messagesRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );

      if (!messagesRes.ok) {
        let errMessage = messagesRes.statusText;
        try {
          const errData = await messagesRes.json();
          if (errData.error?.message) errMessage = errData.error.message;
        } catch (e) {}
        await recordSyncError(`Gmail API error: ${errMessage}`);
        return jsonResponse({ error: `Gmail API error: ${errMessage}` }, 500);
      }

      let messagesData;
      try {
        messagesData = await messagesRes.json();
      } catch (e) {
        await recordSyncError("Gmail API error: failed to parse JSON response.");
        return jsonResponse({ error: `Gmail API error: Failed to parse JSON response.` }, 500);
      }

      const messages = messagesData.messages || [];
      allMessages.push(...messages);
      pageToken = messagesData.nextPageToken;
    } while (pageToken);

    let syncedCount = 0;

    for (const msg of allMessages) {
      if (!msg.id) continue;

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!msgRes.ok) continue;

      let msgDetail;
      try {
        msgDetail = await msgRes.json();
      } catch (e) {
        continue;
      }
      
      const payload = msgDetail.payload;
      const headers = payload?.headers || [];
      const rawHeaders = headers.reduce((acc: any, h: any) => {
        acc[h.name] = h.value;
        return acc;
      }, {});

      const subject = rawHeaders["Subject"] || "";
      const sender = rawHeaders["From"] || "";
      const recipients = rawHeaders["To"] || "";
      const dateStr = rawHeaders["Date"] || "";
      let receivedAt = null;
      if (dateStr) {
        try {
          receivedAt = new Date(dateStr).toISOString();
        } catch(e) {}
      }
      
      const snippet = msgDetail.snippet || "";
      const bodyText = getMessageBody(payload);

      const isRead = !(msgDetail.labelIds || []).includes("UNREAD");

      try {
        await supabaseAdmin.from("emails").upsert({
          user_id: userId,
          gmail_message_id: msgDetail.id,
          thread_id: msgDetail.threadId,
          sender,
          recipients,
          subject,
          snippet,
          body_text: bodyText,
          raw_headers: rawHeaders,
          received_at: receivedAt,
          is_read: isRead
        }, { onConflict: "user_id,gmail_message_id" });

        syncedCount++;
      } catch (_err) {
        log.error("email_upsert_failed");
        // Continue syncing other emails
      }
    }

    // Update last_synced_at and clear any prior sync error.
    await supabaseAdmin.from("connected_accounts")
      .update({ last_synced_at: new Date().toISOString(), status: 'active', last_sync_error: null, last_sync_error_at: null })
      .eq('user_id', userId)
      .eq('provider', 'google');

    // C3: after a sync that ingested new data, enqueue memory extraction.
    // Reuses the llm_jobs queue + llm-worker and the SAME idempotency guard as
    // the memory-extraction function: skip if one is already pending/processing
    // for this user. Best-effort — never fails the sync response.
    if (syncedCount > 0) {
      try {
        const { data: existingJobs } = await supabaseAdmin
          .from("llm_jobs")
          .select("id")
          .eq("user_id", userId)
          .eq("job_type", "memory_extraction")
          .in("status", ["pending", "processing"])
          .limit(1);
        if (!existingJobs || existingJobs.length === 0) {
          await supabaseAdmin.from("llm_jobs").insert({
            user_id: userId,
            job_type: "memory_extraction",
            priority: 2,
            status: "pending",
            payload: { request_id: requestId, source: "gmail-sync" }
          });
        }
      } catch (_e) {
        log.warn("extraction_enqueue_failed");
      }
    }

    return jsonResponse({ success: true, syncedCount });

  } catch (_err) {
    log.error("unhandled error");
    await recordSyncError("Unexpected error during Gmail sync.");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
