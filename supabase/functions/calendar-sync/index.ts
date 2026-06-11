import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

    if (!googleClientId || !googleClientSecret) {
      return jsonResponse({ error: "Missing Google OAuth credentials." }, 500);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Get integration secrets
    const { data: secretData, error: secretErr } = await supabaseAdmin
      .from("integration_secrets")
      .select("*")
      .eq("user_id", user.id)
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
        console.log("TOKEN_REFRESH_FAILED");
        await supabaseAdmin.from("connected_accounts").update({ status: 'broken' }).eq('user_id', user.id).eq('provider', 'google');
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
      } catch (e) {
        console.log("TOKEN_REFRESH_FAILED", e);
        await supabaseAdmin.from("connected_accounts").update({ status: 'broken' }).eq('user_id', user.id).eq('provider', 'google');
        return jsonResponse({ error: "Refresh failed: Unparseable response from Google." }, 401);
      }

      if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
        console.log("TOKEN_REFRESH_FAILED");
        await supabaseAdmin.from("connected_accounts").update({ status: 'broken' }).eq('user_id', user.id).eq('provider', 'google');
        return jsonResponse({ error: `Refresh failed: ${tokenData.error_description || tokenData.error || "Missing access token"}` }, 401);
      }

      accessToken = tokenData.access_token;
      const tokenExpiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : null;

      await supabaseAdmin.from("integration_secrets").update({
        access_token: accessToken,
        token_expires_at: tokenExpiresAt,
        updated_at: new Date().toISOString()
      }).eq('id', secretData.id);

      console.log("TOKEN_REFRESHED");
    } else {
      console.log("TOKEN_VALID");
    }

    // 3. Fetch Google Calendar events
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const timeMin = today.toISOString();
    
    const calendarRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=50&orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}`, 
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!calendarRes.ok) {
      let errMessage = calendarRes.statusText;
      try {
        const errData = await calendarRes.json();
        if (errData.error?.message) errMessage = errData.error.message;
      } catch (e) {}
      return jsonResponse({ error: `Calendar API error: ${errMessage}` }, 500);
    }

    let calendarData;
    try {
      calendarData = await calendarRes.json();
    } catch (e) {
      return jsonResponse({ error: `Calendar API error: Failed to parse JSON response.` }, 500);
    }

    const eventsList = calendarData.items || [];
    let syncedCount = 0;

    for (const evt of eventsList) {
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
          user_id: user.id,
          google_event_id,
          title,
          description,
          start_time,
          end_time,
          location,
          status
        }, { onConflict: "user_id,google_event_id" });

        syncedCount++;
      } catch (err) {
        console.error(`Failed to upsert event ${google_event_id}:`, err);
        // Continue syncing other events
      }
    }

    // 4. Update last_synced_at
    await supabaseAdmin.from("connected_accounts")
      .update({ last_synced_at: new Date().toISOString(), status: 'active' })
      .eq('user_id', user.id)
      .eq('provider', 'google');

    return jsonResponse({ success: true, syncedCount });

  } catch (err) {
    return jsonResponse({ error: `Internal error: ${err.message}` }, 500);
  }
});
