import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { getUserPlan, planAllowsIntegration } from "../_shared/plans.ts";
import { createLogger, newRequestId } from "../_shared/log.ts";

const RATE_LIMIT_PER_MIN = 10;
const NOTION_VERSION = "2022-06-28";

// Extract a human-readable title from a Notion page object.
function extractTitle(page: any): string {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title.map((t: any) => t.plain_text || "").join("");
      if (text) return text;
    }
  }
  return "Untitled";
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const requestId = newRequestId();
  const log = createLogger("notion-sync", requestId);

  function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Invalid user token" }, 401);

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const rl = await checkRateLimit(supabaseAdmin, user.id, "notion-sync", RATE_LIMIT_PER_MIN);
    if (rl.limited) return jsonResponse({ error: "Rate limit exceeded. Try again shortly." }, 429);

    const plan = await getUserPlan(supabaseAdmin, user.id);
    if (!planAllowsIntegration(plan, "notion")) {
      return jsonResponse({ error: "Notion integration requires the Business plan. Please upgrade.", code: "upgrade_required" }, 402);
    }

    const { data: secretData, error: secretErr } = await supabaseAdmin
      .from("integration_secrets")
      .select("*")
      .eq("user_id", user.id)
      .eq("provider", "notion")
      .single();

    if (secretErr || !secretData?.access_token) {
      return jsonResponse({ error: "Notion connection not found." }, 404);
    }

    const accessToken = secretData.access_token;

    // Search recently edited pages the integration can access.
    const searchRes = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({
        filter: { value: "page", property: "object" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 20,
      }),
    });

    let searchData;
    try {
      searchData = await searchRes.json();
    } catch (_e) {
      return jsonResponse({ error: "Notion API error: unparseable response." }, 500);
    }

    if (!searchRes.ok) {
      if (searchRes.status === 401) {
        await supabaseAdmin.from("connected_accounts")
          .update({ status: "broken" }).eq("user_id", user.id).eq("provider", "notion");
        return jsonResponse({ error: "Notion authorization is no longer valid. Reconnect required." }, 401);
      }
      return jsonResponse({ error: `Notion API error: ${searchData?.message || searchRes.statusText}` }, 500);
    }

    const pages = searchData.results || [];
    let syncedCount = 0;

    for (const page of pages) {
      if (!page.id || page.object !== "page") continue;
      const title = extractTitle(page);

      try {
        await supabaseAdmin.from("notion_pages").upsert({
          user_id: user.id,
          notion_page_id: page.id,
          title,
          url: page.url ?? null,
          content: title,
          last_edited_at: page.last_edited_time ?? null,
        }, { onConflict: "user_id,notion_page_id" });
        syncedCount++;
      } catch (_err) {
        log.error("notion_page_upsert_failed");
      }
    }

    await supabaseAdmin.from("connected_accounts")
      .update({ last_synced_at: new Date().toISOString(), status: "active" })
      .eq("user_id", user.id)
      .eq("provider", "notion");

    return jsonResponse({ success: true, syncedCount });

  } catch (_err) {
    log.error("unhandled error");
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
