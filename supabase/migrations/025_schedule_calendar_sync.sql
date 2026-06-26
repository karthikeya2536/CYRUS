-- ============================================
-- Migration: 025_schedule_calendar_sync
-- ============================================
-- Schedules the existing calendar-sync Edge Function to run automatically for
-- every connected Google account, using the SAME pg_cron + pg_net + Vault
-- infrastructure as migrations 022 (llm-worker) and 024 (gmail-sync). No new
-- tables, no new functions, no new secrets.
--
-- calendar-sync gained the same system-invocation path as gmail-sync: when
-- called with a matching x-worker-secret header and a {"user_id": ...} body it
-- runs the identical sync for that user. This cron fans out one pg_net request
-- per active Google account.
--
-- DESIGN NOTES (identical rationale to migrations 022/024):
--   - pg_cron is platform-managed; we check pg_extension, never CREATE EXTENSION.
--   - Reuses the existing Vault secrets 'project_url' and 'worker_secret'.
--   - No BEGIN/COMMIT -- the Supabase CLI wraps migrations in a transaction.
--   - cron.schedule replaces an existing named job (idempotent); the prior
--     unschedule is defensive.
--   - Runs every 15 minutes. calendar-sync upserts on
--     (user_id, google_event_id), so repeated runs are safe.
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
      'The calendar-sync cron schedule will not be created. '
      'Run scripts/setup-worker.sql after migration to provision secrets '
      'and enable the scheduler.';
    RETURN;
  END IF;

  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF NOT FOUND THEN
    RAISE NOTICE 'pg_cron not installed; calendar-sync will not be scheduled '
      'automatically. Enable pg_cron in Dashboard -> Database -> Extensions, '
      'then re-run this migration.';
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.unschedule('calendar-sync-cron');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No prior calendar-sync-cron to unschedule: %', SQLERRM;
  END;

  -- One pg_net request per active Google account, every 15 minutes.
  PERFORM cron.schedule(
    'calendar-sync-cron',
    '*/15 * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url')
                    || '/functions/v1/calendar-sync',
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

  RAISE NOTICE 'Scheduled calendar-sync-cron (every 15 minutes).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule calendar-sync-cron: %', SQLERRM;
END $$;

-- ============================================
-- ROLLBACK
-- ============================================
-- SELECT cron.unschedule('calendar-sync-cron');  -- returns false if not found
-- ============================================

-- ============================================
-- VERIFICATION
-- ============================================
-- Confirm the schedule is active:
--   SELECT jobid, schedule, command FROM cron.job
--    WHERE jobname = 'calendar-sync-cron';
--
-- Inspect recent runs:
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'calendar-sync-cron')
--    ORDER BY start_time DESC LIMIT 10;
-- ============================================
