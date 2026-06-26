-- Stage 1 & 2 crons (will fail if pg_cron is missing)
SELECT jobname,schedule,active FROM cron.job WHERE jobname IN ('gmail-sync-cron', 'calendar-sync-cron');

-- Connected accounts
SELECT provider,status,last_synced_at FROM connected_accounts;

-- Events / emails
SELECT count(*) as emails_count FROM emails;
SELECT count(*) as calendar_events_count FROM calendar_events;

-- Jobs
SELECT job_type, status, count(*) FROM llm_jobs GROUP BY job_type, status;

-- Permanently failed jobs
SELECT id,job_type,status,attempts,last_error FROM llm_jobs WHERE status='permanently_failed' ORDER BY created_at DESC LIMIT 10;

-- Memory records
SELECT count(*) as memory_records_count FROM memory_records;

-- Briefings
SELECT id,user_id,generated_at,generator_provider FROM briefings ORDER BY generated_at DESC LIMIT 10;

-- Quota Enforcement
SELECT user_id, created_at::date as day, count(*) FROM llm_jobs WHERE job_type='briefing_generation' AND payload->>'source'='system' GROUP BY user_id,day ORDER BY day DESC;
SELECT * FROM usage_counters WHERE metric='briefings' ORDER BY day DESC LIMIT 10;
