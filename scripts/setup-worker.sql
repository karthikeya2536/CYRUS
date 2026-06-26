-- ============================================
-- scripts/setup-worker.sql
-- ============================================
-- Creates Vault secrets for the llm-worker cron schedule and activates the
-- pg_cron schedule. Idempotent -- safe to run repeatedly.
--
-- Usage:
--   psql -h localhost -p 54322 -U postgres -d postgres \
--     -v project_url='http://host.docker.internal:54321' \
--     -v worker_secret='dev-worker-secret' \
--     -f scripts/setup-worker.sql
--
-- In CI: use the values above (local Supabase stack).
-- In production/staging: use the real Supabase project URL and a random secret.
--
-- After running, sync WORKER_SECRET to the edge function env:
--   supabase secrets set WORKER_SECRET=<worker_secret>
-- ============================================

-- 1. Create or update Vault secrets (idempotent)
DO $$
DECLARE
  v_id uuid;
BEGIN
  -- project_url
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'project_url';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(:'project_url', 'project_url');
  ELSE
    PERFORM vault.update_secret(v_id, :'project_url');
  END IF;

  -- worker_secret
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'worker_secret';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(:'worker_secret', 'worker_secret');
  ELSE
    PERFORM vault.update_secret(v_id, :'worker_secret');
  END IF;
END;
$$;

-- 2. Schedule the cron job (idempotent -- cron.schedule replaces by name)
DO $$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'pg_cron';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pg_cron is not installed. Enable it first.';
  END IF;

  PERFORM cron.schedule(
    'llm-worker-drain',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url') || '/functions/v1/llm-worker',
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

  -- gmail-sync: one request per active Google account, every 15 minutes
  -- (migration 024). Reuses the same Vault secrets and worker secret.
  PERFORM cron.schedule(
    'gmail-sync-cron',
    '*/15 * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url') || '/functions/v1/gmail-sync',
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

  -- calendar-sync: one request per active Google account, every 15 minutes
  -- (migration 025). Reuses the same Vault secrets and worker secret.
  PERFORM cron.schedule(
    'calendar-sync-cron',
    '*/15 * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url') || '/functions/v1/calendar-sync',
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

  -- generate-briefing: one request per active Google account, once daily at
  -- 08:17 UTC (migration 026). Daily quota + dedup enforce one briefing/day.
  PERFORM cron.schedule(
    'briefing-generation-cron',
    '17 8 * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret
                    FROM vault.decrypted_secrets
                    WHERE name = 'project_url') || '/functions/v1/generate-briefing',
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
END;
$$;
