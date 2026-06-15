-- ============================================
-- Migration: 022_schedule_llm_worker
-- ============================================
-- Schedules the existing llm-worker Edge Function to drain llm_jobs every
-- minute using pg_cron + pg_net. The Edge Function code, llm_jobs schema,
-- retry logic, optimistic locking, dead-letter behavior, and producer
-- functions are ALL UNCHANGED. This migration adds only a schedule.
--
-- Pre-deploy requirements (see DEPLOYMENT.md):
--   1. supabase_vault extension enabled in Dashboard.
--   2. pg_cron extension enabled in Dashboard (Pro plan+; Free plan requires
--      upgrade or manual via Integrations -> Cron).
--   3. Two Vault secrets created via SQL editor:
--        SELECT vault.create_secret('https://<REF>.supabase.co', 'project_url');
--        SELECT vault.create_secret('<your-chosen-secret>', 'worker_secret');
--   4. Edge Function env synced:
--        supabase secrets set WORKER_SECRET=<same-value-as-worker_secret>
--
-- DESIGN NOTES:
--   - pg_cron is NOT CREATE EXTENSION here. On hosted Supabase the platform
--     manages pg_cron; trying CREATE EXTENSION can fail or duplicate the
--     schema. Instead, we check pg_extension like migration 019 does.
--   - pg_net requires no migration action — it is pre-installed by Supabase.
--   - Vault secrets are NOT auto-generated or hardcoded. They must be set per
--     environment. An auto-generated value cannot be synced back to the
--     Edge Function env (no read path from Vault to env var).
--   - No BEGIN/COMMIT — Supabase CLI wraps migrations in its own transaction.
--   - cron.unschedule(text) returns BOOLEAN (true if removed, false if not
--     found). It raises "could not find valid entry" only when called by a
--     different PostgreSQL user than the one who created the job. The
--     EXCEPTION handler guards this cross-user edge case.
--   - cron.schedule(job_name, ...) is itself idempotent — it replaces an
--     existing named job — so the prior unschedule is defensive, not
--     required, but included for clarity.
-- ============================================

-- 1. Guard: ensure Vault secrets exist BEFORE scheduling the cron job.
--    Without these, net.http_post would call a broken URL with a missing
--    auth header — silently failing every minute with no diagnostic.
--    Fail the migration upfront so the operator sees the error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url'
  ) THEN
    RAISE EXCEPTION 'Vault secret "project_url" not found. '
      'Create it before running this migration: '
      'SELECT vault.create_secret(''https://<REF>.supabase.co'', ''project_url'');';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_secret'
  ) THEN
    RAISE EXCEPTION 'Vault secret "worker_secret" not found. '
      'Create it before running this migration: '
      'SELECT vault.create_secret(''<your-secret>'', ''worker_secret'');';
  END IF;
END $$;

-- 2. Validate the project_url secret has the expected format. Catches the
--    failure mode where someone stores a placeholder like
--    'https://YOUR_PROJECT_REF.supabase.co' and the schedule silently
--    hits a non-existent host forever.
DO $$
DECLARE
  v_url TEXT;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'project_url';

  IF v_url IS NULL OR v_url = '' THEN
    RAISE EXCEPTION 'Vault secret "project_url" is empty.';
  END IF;

  IF v_url LIKE '%YOUR_PROJECT_REF%'
     OR v_url LIKE '%<REF>%'
     OR v_url LIKE '%example%'
  THEN
    RAISE EXCEPTION 'Vault secret "project_url" appears to be a placeholder: %. '
      'Replace with the actual Supabase project URL.', v_url;
  END IF;

  IF v_url NOT LIKE 'https://%.supabase.co' THEN
    RAISE WARNING 'Vault secret "project_url" does not match expected pattern '
      'https://<ref>.supabase.co — value: %. Verify this is correct.', v_url;
  END IF;
END $$;

-- 3. Schedule the worker drain (guarded for pg_cron availability).
--    Matches the established pattern in 019_retrieval_observability.sql.
--    The unschedule is defensive — cron.schedule(job_name, ...) replaces
--    an existing named job, making it idempotent. But explicitly removing
--    prior state first makes the intent clear and protects against any
--    future pg_cron behavior change.
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF NOT FOUND THEN
    RAISE NOTICE 'pg_cron not installed; llm-worker will not be scheduled '
      'automatically. Enable pg_cron in Dashboard -> Database -> Extensions, '
      'then re-run this migration.';
    RETURN;
  END IF;

  -- Defensive: remove any prior schedule. cron.unschedule(text) returns false
  -- when the job does not exist. The EXCEPTION handler guards the rare
  -- cross-user edge case where it raises instead.
  BEGIN
    PERFORM cron.unschedule('llm-worker-drain');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No prior llm-worker-drain to unschedule: %', SQLERRM;
  END;

  PERFORM cron.schedule(
    'llm-worker-drain',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url')
                    || '/functions/v1/llm-worker',
        headers := jsonb_build_object(
          'Content-Type',    'application/json',
          'x-worker-secret', (SELECT decrypted_secret
                               FROM vault.decrypted_secrets
                               WHERE name = 'worker_secret')
        ),
        body                := '{}'::jsonb,
        timeout_milliseconds := 55000
      );
    $cron$
  );

  RAISE NOTICE 'Scheduled llm-worker-drain (every minute).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule llm-worker-drain: %', SQLERRM;
END $$;

-- ============================================
-- ROLLBACK
-- ============================================
-- SELECT cron.unschedule('llm-worker-drain');  -- returns false if not found
--
-- To remove Vault secrets:
--   DELETE FROM vault.secrets WHERE name IN ('project_url', 'worker_secret');
--
-- To remove the Edge Function env var:
--   supabase secrets unset WORKER_SECRET
-- ============================================

-- ============================================
-- VERIFICATION
-- ============================================
-- Confirm the schedule is active:
--   SELECT jobid, schedule, command FROM cron.job
--    WHERE jobname = 'llm-worker-drain';
--
-- Confirm Vault secrets exist (names visible, values encrypted):
--   SELECT name FROM vault.secrets
--    WHERE name IN ('project_url', 'worker_secret');
--
-- Manual test from shell:
--   curl -X POST \
--     -H "Content-Type: application/json" \
--     -H "x-worker-secret: <YOUR_WORKER_SECRET>" \
--     https://<REF>.supabase.co/functions/v1/llm-worker \
--     -d '{}'
--   Expected: 200 with {"success":true,...} or "No pending jobs"
-- ============================================
