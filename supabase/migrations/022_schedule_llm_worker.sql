-- ============================================
-- Migration: 022_schedule_llm_worker
-- ============================================
-- Schedules the existing llm-worker Edge Function to drain llm_jobs every
-- minute using pg_cron + pg_net. The Edge Function code, llm_jobs schema,
-- retry logic, optimistic locking, dead-letter behavior, and producer
-- functions are ALL UNCHANGED. This migration adds only a schedule.
--
-- DESIGN NOTES:
--   - pg_cron is NOT CREATE EXTENSION here. On hosted Supabase the platform
--     manages pg_cron; trying CREATE EXTENSION can fail or duplicate the
--     schema. Instead, we check pg_extension like migration 019 does.
--   - pg_net requires no migration action -- it is pre-installed by Supabase.
--   - Vault secrets are NOT auto-generated or hardcoded. They must be
--     provisioned per environment via scripts/setup-worker.sql.
--   - No BEGIN/COMMIT -- Supabase CLI wraps migrations in its own transaction.
--   - cron.unschedule(text) returns BOOLEAN (true if removed, false if not
--     found). It raises "could not find valid entry" only when called by a
--     different PostgreSQL user than the one who created the job. The
--     EXCEPTION handler guards this cross-user edge case.
--   - cron.schedule(job_name, ...) is itself idempotent -- it replaces an
--     existing named job -- so the prior unschedule is defensive, not
--     required, but included for clarity.
-- ============================================

-- 1. Conditional: if Vault secrets exist, validate and schedule. If not,
--    log a NOTICE and skip. The schedule is activated later when the
--    operator runs scripts/setup-worker.sql. This ensures the migration
--    always passes on a clean database (supabase db reset).
DO $$
DECLARE
  v_url TEXT;
  v_has_secrets BOOLEAN;
BEGIN
  -- Check if Vault secrets exist
  v_has_secrets := EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url'
  ) AND EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_secret'
  );

  IF NOT v_has_secrets THEN
    RAISE NOTICE 'Vault secrets not found. '
      'The llm-worker cron schedule will not be created. '
      'Run scripts/setup-worker.sql after migration to provision secrets '
      'and enable the scheduler.';
    RETURN;
  END IF;

  -- Validate project_url format
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

  -- Check pg_cron availability
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF NOT FOUND THEN
    RAISE NOTICE 'pg_cron not installed; llm-worker will not be scheduled '
      'automatically. Enable pg_cron in Dashboard -> Database -> Extensions, '
      'then re-run this migration.';
    RETURN;
  END IF;

  -- Defensive: remove any prior schedule
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
