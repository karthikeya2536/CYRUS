-- ============================================
-- One-off: validate extractor/verifier quality with 3 known emails
-- ============================================
-- IMPORTANT: run this only AFTER the new llm-worker + prompts.ts + migration 031
-- are DEPLOYED. Otherwise the currently-deployed (old) worker processes the job
-- and you are testing the old behavior.
--
-- Expected results:
--   test-email-A "Final project report due Friday evening."        -> deadline memory
--   test-email-B "LinkedIn notification: John liked your post."    -> NO memory (REJECT/[])
--   test-email-C "Need to follow up with recruiter Priya next week"-> commitment memory
--
-- Seeds 3 emails for the active Google user, enqueues a memory_extraction job,
-- then (after the minute cron runs) you inspect by source_id. CLEANUP removes
-- the test rows.
-- ============================================

-- ---- PHASE 1: seed the 3 test emails (newest, so extraction's latest-10 sees them) ----
INSERT INTO public.emails (user_id, gmail_message_id, sender, subject, snippet, received_at, is_read)
SELECT u, gid, sndr, subj, snip, now(), false
FROM (SELECT user_id AS u FROM public.connected_accounts
      WHERE provider='google' AND status='active' LIMIT 1) acc
CROSS JOIN (VALUES
  ('test-email-A', 'Project Team <team@example.com>',  'Project report',        'Final project report due Friday evening.'),
  ('test-email-B', 'LinkedIn <notify@linkedin.com>',   'LinkedIn',              'LinkedIn notification: John liked your post.'),
  ('test-email-C', 'Recruiting <talent@example.com>',  'Recruiter follow-up',   'Need to follow up with recruiter Priya next week.')
) AS t(gid, sndr, subj, snip)
ON CONFLICT (user_id, gmail_message_id) DO UPDATE
  SET subject = EXCLUDED.subject, snippet = EXCLUDED.snippet, received_at = now();

-- ---- PHASE 2: enqueue extraction for that user ----
INSERT INTO public.llm_jobs (user_id, job_type, priority, status, payload)
SELECT user_id, 'memory_extraction', 1, 'pending',
       jsonb_build_object('source','extraction-quality-test')
FROM public.connected_accounts
WHERE provider='google' AND status='active' LIMIT 1
RETURNING id, user_id, status;

-- ---- PHASE 3: inspect (run ~1-2 min later, after the cron worker processes it) ----
-- Per-source verifier decision (the ground truth signal):
SELECT source_id, decision, extractor_provider, verifier_provider, confidence
FROM public.memory_extraction_logs
WHERE source_id IN ('test-email-A','test-email-B','test-email-C')
ORDER BY source_id;

-- Memories actually written for the test emails:
SELECT source_id, category, content, expires_at, confidence_score, active
FROM public.memory_records
WHERE source_id IN ('test-email-A','test-email-B','test-email-C')
ORDER BY source_id;
-- PASS if: A -> category 'deadline' (expires_at ~ Friday + 7d), B -> no row,
--          C -> category 'commitment' (expires_at NULL).

-- ---- CLEANUP (run when done) ----
-- DELETE FROM public.memory_records WHERE source_id IN ('test-email-A','test-email-B','test-email-C');
-- DELETE FROM public.emails WHERE gmail_message_id IN ('test-email-A','test-email-B','test-email-C');
