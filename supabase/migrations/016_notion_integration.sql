-- ============================================
-- Migration: Notion integration
-- ============================================
-- Stores Notion pages synced for a user. Mirrors slack_messages/emails shape:
-- per-user rows, RLS by auth.uid(), unique on (user_id, notion_page_id).
-- OAuth token reuses integration_secrets (provider='notion'); the account row
-- reuses connected_accounts (provider='notion'). No new secret table needed.

-- ============================================
-- UP
-- ============================================
CREATE TABLE IF NOT EXISTS public.notion_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notion_page_id TEXT NOT NULL,
  title TEXT,
  url TEXT,
  content TEXT,
  last_edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, notion_page_id)
);

ALTER TABLE public.notion_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own notion_pages" ON public.notion_pages;
DROP POLICY IF EXISTS "Users can delete own notion_pages" ON public.notion_pages;

-- Rows are authored by the sync function (service role); users read/delete only.
CREATE POLICY "Users can read own notion_pages" ON public.notion_pages FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own notion_pages" ON public.notion_pages FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_notion_pages_user_edited
  ON public.notion_pages (user_id, last_edited_at DESC);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP INDEX IF EXISTS public.idx_notion_pages_user_edited;
-- DROP TABLE IF EXISTS public.notion_pages;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--     AND tablename='notion_pages';  -- expect rowsecurity=true
