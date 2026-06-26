-- ============================================
-- One-off: re-run memory extraction on fresh data
-- ============================================
-- Enqueues a `memory_extraction` job for every active Google account. The
-- llm-worker cron (every minute) drains it and re-extracts from the latest
-- ~10 emails + next 30 days of calendar events using the hardened verifier
-- and deterministic expiration.
--
-- Respects the same idempotency guard the app uses (memory-extraction/index.ts,
-- gmail-sync/index.ts): it will NOT enqueue a second job for a user who already
-- has one pending or processing.
--
-- Run AFTER scripts/purge-garbage-memories.sql, and after migration 031 +
-- the llm-worker changes are deployed.
--
-- HOW TO RUN:
--   supabase db query -f scripts/reextract-fresh.sql --linked
-- ============================================

INSERT INTO public.llm_jobs (user_id, job_type, priority, status, payload)
SELECT ca.user_id, 'memory_extraction', 2, 'pending',
       jsonb_build_object('source', 'manual-reextract')
FROM public.connected_accounts ca
WHERE ca.provider = 'google'
  AND ca.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM public.llm_jobs j
    WHERE j.user_id = ca.user_id
      AND j.job_type = 'memory_extraction'
      AND j.status IN ('pending', 'processing')
  )
RETURNING id, user_id, status;

-- ---- Watch progress ----
-- SELECT status, count(*) FROM public.llm_jobs
--  WHERE job_type = 'memory_extraction' GROUP BY status;
-- SELECT id, status, last_error, result FROM public.llm_jobs
--  WHERE job_type = 'memory_extraction' ORDER BY created_at DESC LIMIT 10;
