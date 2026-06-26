#!/usr/bin/env bash
# ============================================================================
# scripts/validate-phase-c.sh
# ----------------------------------------------------------------------------
# Single end-to-end validation runbook for the Phase C automated pipeline.
# Run AFTER configuring Google creds + reconnecting Google in the UI.
#
# It does NOT modify code. It drives the pipeline exactly as cron does
# (x-worker-secret system invocations) and checks each stage's DB state.
#
# Usage (local stack, from repo root):
#   bash scripts/validate-phase-c.sh
#
# Requires: running local Supabase stack (containers supabase_db_cyrus_v2 +
# supabase_edge_runtime_cyrus_v2), WORKER_SECRET present in the edge runtime,
# migrations 022-026 applied, and a reconnected Google account.
# ============================================================================
set -uo pipefail

DB=supabase_db_cyrus_v2
GW=http://localhost:54321
PSQL="docker exec -i $DB psql -U postgres -d postgres -tAc"

WS=$(docker exec "$DB" psql -U postgres -d postgres -tAc \
  "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='worker_secret';")
ACCT=$(docker exec "$DB" psql -U postgres -d postgres -tAc \
  "SELECT user_id FROM connected_accounts WHERE provider='google' AND status='active' LIMIT 1;")

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; }
hdr()  { echo ""; echo "== $1 =="; }

q() { docker exec "$DB" psql -U postgres -d postgres -tAc "$1"; }

post() { # $1=function $2=json-body
  curl -s -X POST -H "Content-Type: application/json" -H "x-worker-secret: $WS" \
    "$GW/functions/v1/$1" -d "$2";
}

drain_worker() { # poll the worker until the given job_type has no pending/processing rows
  local jt=$1 tries=${2:-30}
  for _ in $(seq 1 "$tries"); do
    post llm-worker '{}' >/dev/null
    local n; n=$(q "SELECT count(*) FROM llm_jobs WHERE job_type='$jt' AND status IN ('pending','processing');")
    [ "$n" = "0" ] && return 0
    sleep 3
  done
  return 1
}

echo "Account under test: ${ACCT:-<none>}"
[ -z "$ACCT" ] && { fail "no active Google connected_account — reconnect first"; exit 1; }

# 1 -------------------------------------------------------------------------
hdr "1. integration_secrets populated"
HAS=$(q "SELECT (refresh_token IS NOT NULL AND refresh_token<>'') FROM integration_secrets WHERE user_id='$ACCT' AND provider='google';")
[ "$HAS" = "t" ] && pass "refresh_token present" || { fail "no refresh_token — reconnect Google"; exit 1; }

# 2 -------------------------------------------------------------------------
hdr "2. connected_accounts active"
q "SELECT provider,status,last_synced_at FROM connected_accounts WHERE user_id='$ACCT';"

# 3 -------------------------------------------------------------------------
hdr "3. Gmail sync"
R=$(post gmail-sync "{\"user_id\":\"$ACCT\"}"); echo "  resp: $R"
echo "$R" | grep -q '"success":true' && pass "gmail-sync ok" || fail "gmail-sync failed (see resp)"

# 4 -------------------------------------------------------------------------
hdr "4. Calendar sync"
R=$(post calendar-sync "{\"user_id\":\"$ACCT\"}"); echo "  resp: $R"
echo "$R" | grep -q '"success":true' && pass "calendar-sync ok" || fail "calendar-sync failed (see resp)"

# 5,6 -----------------------------------------------------------------------
hdr "5/6. Rows ingested"
q "SELECT (SELECT count(*) FROM emails WHERE user_id='$ACCT') AS emails,
          (SELECT count(*) FROM calendar_events WHERE user_id='$ACCT') AS events;"

# 7 -------------------------------------------------------------------------
hdr "7. memory_extraction job created"
q "SELECT id,status,payload->>'source' src FROM llm_jobs
   WHERE user_id='$ACCT' AND job_type='memory_extraction' ORDER BY created_at DESC LIMIT 3;"

# 8 -------------------------------------------------------------------------
hdr "8. memory_extraction completed (driving worker)"
drain_worker memory_extraction && pass "extraction drained" || fail "extraction stuck (check last_error)"
q "SELECT status,attempts,coalesce(last_error,'-') FROM llm_jobs
   WHERE user_id='$ACCT' AND job_type='memory_extraction' ORDER BY created_at DESC LIMIT 3;"

# 9 -------------------------------------------------------------------------
hdr "9. memory_records created"
q "SELECT count(*) AS memories,
          count(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
          count(DISTINCT llm_provider) AS providers
   FROM memory_records WHERE user_id='$ACCT';"

# 10 ------------------------------------------------------------------------
hdr "10. briefing_generation job created"
R=$(post generate-briefing "{\"user_id\":\"$ACCT\"}"); echo "  resp: $R"

# 11 ------------------------------------------------------------------------
hdr "11. briefing completed (driving worker)"
drain_worker briefing_generation && pass "briefing drained" || fail "briefing stuck (check last_error)"

# 12 ------------------------------------------------------------------------
hdr "12. Briefing content + quality indicators"
q "SELECT generator_provider, verifier_provider,
          email_count_used, event_count_used,
          length(content) AS content_chars,
          (length(content)-length(replace(content,'##','')))/2 AS section_count
   FROM briefings WHERE user_id='$ACCT' ORDER BY generated_at DESC LIMIT 1;"
echo "  --- content (latest) ---"
q "SELECT content FROM briefings WHERE user_id='$ACCT' ORDER BY generated_at DESC LIMIT 1;"

hdr "QUALITY READ"
echo "  * generator_provider = 'rule-engine'  -> LLM keys missing; quality will be shallow."
echo "  * email/event_count_used = 0          -> briefing not grounded in synced data."
echo "  * section_count low / generic content -> funnel/extraction weak (-> prioritise D1)."
echo ""
echo "Done."
