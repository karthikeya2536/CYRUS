-- ============================================
-- Migration: Slack integration
-- ============================================
-- Stores Slack messages synced for a user. Mirrors the emails/calendar_events
-- shape: per-user rows, RLS by auth.uid(), unique on (user_id, slack_ts).
-- OAuth tokens reuse integration_secrets (provider='slack'); the account row
-- reuses connected_accounts (provider='slack'). No new secret table needed.

-- ============================================
-- UP
-- ============================================
CREATE TABLE IF NOT EXISTS public.slack_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slack_ts TEXT NOT NULL,
  channel_id TEXT,
  channel_name TEXT,
  author TEXT,
  text TEXT,
  permalink TEXT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, slack_ts)
);

ALTER TABLE public.slack_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own slack_messages" ON public.slack_messages;
DROP POLICY IF EXISTS "Users can delete own slack_messages" ON public.slack_messages;

-- Rows are authored by the sync function (service role); users read/delete only.
CREATE POLICY "Users can read own slack_messages" ON public.slack_messages FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own slack_messages" ON public.slack_messages FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_slack_messages_user_posted
  ON public.slack_messages (user_id, posted_at DESC);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP INDEX IF EXISTS public.idx_slack_messages_user_posted;
-- DROP TABLE IF EXISTS public.slack_messages;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename='slack_messages';  -- expect rowsecurity=true
