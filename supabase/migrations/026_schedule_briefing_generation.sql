-- ============================================
-- Migration: 026_schedule_briefing_generation
-- ============================================
-- Schedules the existing generate-briefing Edge Function to run once daily for
-- every connected Google account, using the SAME pg_cron + pg_net + Vault
-- infrastructure as migrations 022/024/025. No new tables, no new functions,
-- no new secrets, no new job types.
--
-- generate-briefing gained a system-invocation path (x-worker-secret +
-- {"user_id": ...}) that reuses the existing duplicate protection, daily quota
-- enforcement, and llm_jobs insertion. The daily briefing quota (free plan = 1)
-- is what makes this "at most one briefing per user per day" — the cron simply
-- offers each connected user the chance once daily; quota and dedup do the rest.
--
-- DESIGN NOTES (identical rationale to migrations 022/024/025):
--   - pg_cron is platform-managed; we check pg_extension, never CREATE EXTENSION.
--   - Reuses the existing Vault secrets 'project_url' and 'worker_secret'.
--   - No BEGIN/COMMIT -- the Supabase CLI wraps migrations in a transaction.
--   - cron.schedule replaces an existing named job (idempotent); the prior
--     unschedule is defensive.
--   - Runs once daily at 08:17 UTC. Only active Google accounts are targeted,
--     so users with no data source are never offered a briefing (the function
--     also re-checks this on the system path).
-- ============================================

DO $$
DECLARE
  v_has_secrets BOOLEAN;
BEGIN
  v_has_secrets := EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url'
  ) AND EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_secret'
  );

  IF NOT v_has_secrets THEN
    RAISE NOTICE 'Vault secrets not found. '
      'The briefing-generation cron schedule will not be created. '
      'Run scripts/setup-worker.sql after migration to provision secrets '
      'and enable the scheduler.';
    RETURN;
  END IF;

  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF NOT FOUND THEN
    RAISE NOTICE 'pg_cron not installed; briefing generation will not be '
      'scheduled automatically. Enable pg_cron in Dashboard -> Database -> '
      'Extensions, then re-run this migration.';
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.unschedule('briefing-generation-cron');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No prior briefing-generation-cron to unschedule: %', SQLERRM;
  END;

  -- One pg_net request per active Google account, once daily at 08:17 UTC.
  PERFORM cron.schedule(
    'briefing-generation-cron',
    '17 8 * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url')
                    || '/functions/v1/generate-briefing',
        headers := jsonb_build_object(
          'Content-Type',    'application/json',
          'x-worker-secret', (SELECT decrypted_secret
                               FROM vault.decrypted_secrets
                               WHERE name = 'worker_secret')
        ),
        body                := jsonb_build_object('user_id', ca.user_id),
        timeout_milliseconds := 55000
      )
      FROM public.connected_accounts ca
      WHERE ca.provider = 'google'
        AND ca.status = 'active';
    $cron$
  );

  RAISE NOTICE 'Scheduled briefing-generation-cron (daily at 08:17 UTC).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule briefing-generation-cron: %', SQLERRM;
END $$;

-- ============================================
-- ROLLBACK
-- ============================================
-- SELECT cron.unschedule('briefing-generation-cron');  -- false if not found
-- ============================================

-- ============================================
-- VERIFICATION
-- ============================================
-- Confirm the schedule is active:
--   SELECT jobid, schedule, command FROM cron.job
--    WHERE jobname = 'briefing-generation-cron';
--
-- Inspect recent runs:
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'briefing-generation-cron')
--    ORDER BY start_time DESC LIMIT 10;
-- ============================================
