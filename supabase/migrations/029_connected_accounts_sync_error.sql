-- ============================================
-- Migration: 029_connected_accounts_sync_error
-- ============================================
-- TD-001: sync failure observability. gmail-sync / calendar-sync previously only
-- persisted token-refresh failures (via status='broken'); Gmail/Calendar API
-- failures and unexpected exceptions were returned to the caller but never
-- recorded, so a silently failing scheduled sync left no trace on the account.
--
-- These columns let the sync functions persist the last failure reason and time.
-- The success path clears them. Idempotent; safe on a clean reset.
-- No BEGIN/COMMIT (the Supabase CLI wraps each migration in its own transaction).
-- ============================================

ALTER TABLE public.connected_accounts ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
ALTER TABLE public.connected_accounts ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMPTZ;
