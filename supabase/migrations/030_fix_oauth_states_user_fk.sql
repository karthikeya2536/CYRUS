-- ============================================
-- Migration: 030_fix_oauth_states_user_fk
-- ============================================
-- The runtime oauth_states.user_id foreign key was rebuilt out-of-band against a
-- non-existent public.users table:
--   oauth_states_user_id_fkey  FOREIGN KEY (user_id) REFERENCES users(id)
-- public.users has no writer anywhere in the app (users are created in
-- auth.users via signUp and mirrored into public.profiles client-side), so every
-- authenticated user is absent from public.users and create-oauth-state fails
-- with 23503. Every other user FK in the repo (and schema.sql) references
-- auth.users(id); oauth_states must too.
--
-- This repoints the FK to auth.users(id), matching the repo migrations (007/009)
-- and the other tables. Idempotent: on a clean reset the constraint already
-- targets auth.users, so drop-then-add reproduces the same correct constraint.
-- No data change. No BEGIN/COMMIT (the Supabase CLI wraps each migration).
-- ============================================

ALTER TABLE public.oauth_states DROP CONSTRAINT IF EXISTS oauth_states_user_id_fkey;

ALTER TABLE public.oauth_states
  ADD CONSTRAINT oauth_states_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
