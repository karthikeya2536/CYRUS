-- ============================================
-- One-off: purge pre-existing garbage memories  (REVERSIBLE)
-- ============================================
-- Memories created BEFORE the hardened verifier + deterministic expiration
-- (llm-worker / prompts.ts, migration 031) can be low-value permanent rows:
-- bare names, company names, public-figure facts, recurring birthdays, etc.
--
-- This script DEACTIVATES (active = FALSE) matching rows. It never DELETES, so
-- it is fully reversible (see RESTORE). Retrieval already ignores inactive rows
-- after migration 031, so deactivation is enough to remove them from results.
--
-- HOW TO RUN (review each phase; do NOT run blind):
--   supabase db query -f scripts/purge-garbage-memories.sql --linked
-- or paste phases individually into the SQL editor.
--
-- Optional: scope to one user by replacing the user filter in each phase, e.g.
--   AND user_id = '00000000-0000-0000-0000-000000000000'
-- ============================================

-- ---- PHASE 0: how many memories exist, by category ----
SELECT category, count(*) AS total,
       count(*) FILTER (WHERE active) AS active
FROM public.memory_records
GROUP BY category
ORDER BY total DESC;

-- ---- PHASE 1: PREVIEW garbage candidates (no writes) ----
-- Review this list carefully before running PHASE 2. Tune the predicates if it
-- flags rows you want to keep.
SELECT id, category, content, confidence_score, created_at
FROM public.memory_records
WHERE active = TRUE
  AND (
        -- recurring/standalone birthdays
        content ~* '\mbirthday\M'
        -- bare proper-noun names or company names (every word capitalized, 1-4 words)
     OR content ~ '^([A-Z][a-zA-Z]+)( [A-Z][a-zA-Z]+){0,3}$'
        -- public-figure / role facts: "<X> is/was <role> of <Y>"
     OR content ~* '\m(is|was)\M.*\m(founder|co-founder|ceo|cto|cfo|coo|president|owner|head|director)\M.*\mof\M'
  )
ORDER BY category, created_at DESC;

-- ---- PHASE 2: APPLY (deactivate the previewed rows) ----
-- Uncomment to execute once PHASE 1 looks right. Identical predicate to PHASE 1.
--
-- UPDATE public.memory_records
-- SET active = FALSE
-- WHERE active = TRUE
--   AND (
--         content ~* '\mbirthday\M'
--      OR content ~ '^([A-Z][a-zA-Z]+)( [A-Z][a-zA-Z]+){0,3}$'
--      OR content ~* '\m(is|was)\M.*\m(founder|co-founder|ceo|cto|cfo|coo|president|owner|head|director)\M.*\mof\M'
--   );

-- ---- RESTORE (undo PHASE 2) ----
-- Re-activates every row matching the same predicate. Use only if PHASE 2 was
-- too aggressive. (If other deactivations exist, restore by id instead.)
--
-- UPDATE public.memory_records
-- SET active = TRUE
-- WHERE active = FALSE
--   AND (
--         content ~* '\mbirthday\M'
--      OR content ~ '^([A-Z][a-zA-Z]+)( [A-Z][a-zA-Z]+){0,3}$'
--      OR content ~* '\m(is|was)\M.*\m(founder|co-founder|ceo|cto|cfo|coo|president|owner|head|director)\M.*\mof\M'
--   );

-- ============================================
-- ALTERNATIVE (most accurate, heavier): instead of heuristics, deactivate ALL
-- rows for the user (reversible) and let re-extraction (scripts/reextract-fresh.sql)
-- rebuild only what the NEW verifier approves:
--   UPDATE public.memory_records SET active = FALSE WHERE user_id = '<uuid>';
-- Caveat: re-extraction only reads the latest ~10 emails + next 30 days of
-- events, so memories derived from older sources will not be rebuilt.
-- ============================================
