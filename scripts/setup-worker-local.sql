-- 1. Create or update Vault secrets (idempotent)
DO $$
DECLARE
  v_id uuid;
BEGIN
  -- project_url
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'project_url';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret('http://host.docker.internal:54321', 'project_url');
  ELSE
    PERFORM vault.update_secret(v_id, 'http://host.docker.internal:54321');
  END IF;

  -- worker_secret
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'worker_secret';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret('dev-worker-secret', 'worker_secret');
  ELSE
    PERFORM vault.update_secret(v_id, 'dev-worker-secret');
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

  -- gmail-sync
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

  -- calendar-sync
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

  -- generate-briefing
  PERFORM cron.schedule(
    'briefing-generation-cron',
    '* * * * *',  -- Changed to run every minute for testing, was '17 8 * * *'
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
