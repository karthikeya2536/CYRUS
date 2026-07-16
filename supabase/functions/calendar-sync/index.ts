import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 10;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("calendar-sync", requestId);

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

    // Resolve the target user. Two authenticated invocation paths (same pattern
    // as gmail-sync):
    //   1. System (pg_cron -> pg_net): x-worker-secret header matches
    //      WORKER_SECRET; the target user_id is supplied in the request body.
    //   2. User request: caller's JWT is validated via getUser(), then
    //      rate-limited per user. Sync logic below is identical for both.
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

      const rl = await checkRateLimit(supabaseAdmin, user.id, "calendar-sync", RATE_LIMIT_PER_MIN);
      if (rl.limited) {
        return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);
      }

      userId = user.id;
    }

    // 1. Get integration secrets
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
      if (Date.now() > expiresAt - 60000) {
        isExpired = true;
      }
    }

    // 2. Refresh token logic
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

    // 3. Fetch Google Calendar events with pagination
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const timeMin = today.toISOString();

    const timeMaxDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const timeMax = timeMaxDate.toISOString();

    let allEvents: any[] = [];
    let pageToken: string | undefined;
    do {
      const calendarRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=100&orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!calendarRes.ok) {
        let errMessage = calendarRes.statusText;
        try {
          const errData = await calendarRes.json();
          if (errData.error?.message) errMessage = errData.error.message;
        } catch (e) {}
        await recordSyncError(`Calendar API error: ${errMessage}`);
        return jsonResponse({ error: `Calendar API error: ${errMessage}` }, 500);
      }

      let calendarData;
      try {
        calendarData = await calendarRes.json();
      } catch (e) {
        await recordSyncError("Calendar API error: failed to parse JSON response.");
        return jsonResponse({ error: `Calendar API error: Failed to parse JSON response.` }, 500);
      }

      const events = calendarData.items || [];
      allEvents.push(...events);
      pageToken = calendarData.nextPageToken;
    } while (pageToken);

    let syncedCount = 0;

    for (const evt of allEvents) {
      const google_event_id = evt.id;
      if (!google_event_id) continue;

      const title = evt.summary || "";
      const description = evt.description || "";
      const location = evt.location || "";
      const status = evt.status || "";

      let start_time = null;
      if (evt.start?.dateTime) start_time = evt.start.dateTime;
      else if (evt.start?.date) start_time = evt.start.date;

      let end_time = null;
      if (evt.end?.dateTime) end_time = evt.end.dateTime;
      else if (evt.end?.date) end_time = evt.end.date;

      try {
        await supabaseAdmin.from("calendar_events").upsert({
          user_id: userId,
          google_event_id,
          title,
          description,
          start_time,
          end_time,
          location,
          status
        }, { onConflict: "user_id,google_event_id" });

        syncedCount++;
      } catch (_err) {
        log.error("event_upsert_failed");
        // Continue syncing other events
      }
    }

    // 4. Update last_synced_at and clear any prior sync error.
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
            payload: { request_id: requestId, source: "calendar-sync" }
          });
        }
      } catch (_e) {
        log.warn("extraction_enqueue_failed");
      }
    }

    return jsonResponse({ success: true, syncedCount });

  } catch (_err) {
    log.error("unhandled error");
    await recordSyncError("Unexpected error during Calendar sync.");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});

// CACHE BUST: 2026-06-23T20:14:00+05:30 Force Supabase CLI to deploy timeMax fix
