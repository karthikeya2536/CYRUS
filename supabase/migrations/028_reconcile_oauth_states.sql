-- ============================================
-- Migration: 028_reconcile_oauth_states
-- ============================================
-- The runtime database already stores OAuth state as `state_hash` plus a
-- `redirect_uri` column, but repo migrations 007/009 still define the original
-- plaintext `state TEXT NOT NULL UNIQUE` column. That divergence made
-- create-oauth-state fail at runtime with:
--   PGRST204  Could not find the 'state' column of 'oauth_states' ...
-- This migration aligns the repo/CI schema with the runtime contract so a clean
-- `supabase db reset` matches production and the OAuth code (which reads/writes
-- state_hash + redirect_uri) works locally and in CI.
--
-- It is idempotent and a NO-OP on production: state_hash/redirect_uri already
-- exist there, and `state` is already absent. No DB schema is changed where the
-- runtime contract already holds. No data migration is required — create-oauth-state
-- is the only writer of these rows and is fixed in the same change, and broken
-- create-oauth-state means there are no valid in-flight plaintext states.
-- No BEGIN/COMMIT (the Supabase CLI wraps each migration in its own transaction).
-- ============================================

ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS state_hash TEXT;
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS redirect_uri TEXT;

-- The plaintext `state` column is superseded by `state_hash`. Dropping it (only
-- where it still exists, i.e. on a freshly reset repo DB) removes the stale
-- NOT NULL constraint that would otherwise break inserts.
ALTER TABLE public.oauth_states DROP COLUMN IF EXISTS state;

-- Uniqueness now lives on the hash (previously enforced on `state`).
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_state_hash_key
  ON public.oauth_states(state_hash);
