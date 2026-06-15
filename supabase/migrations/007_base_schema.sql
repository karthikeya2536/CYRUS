-- ============================================
-- Migration: Base schema (profiles, accounts, secrets, emails, oauth, calendar)
-- ============================================
-- Promoted from root schema.sql so the migration chain is self-contained:
-- migrations 008+ reference these tables. Idempotent (IF NOT EXISTS + policy
-- guards) so it is safe on an existing database and on a fresh db reset.

-- pgvector must exist before migration 008, which uses vector(768) in RPC
-- signatures. (Re-created idempotently in 011 as well.)
CREATE EXTENSION IF NOT EXISTS vector;

-- ---- profiles ----
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- ---- connected_accounts ----
CREATE TABLE IF NOT EXISTS public.connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_email TEXT,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  UNIQUE(user_id, provider)
);
ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own connected accounts" ON public.connected_accounts;
DROP POLICY IF EXISTS "Users can insert own connected accounts" ON public.connected_accounts;
DROP POLICY IF EXISTS "Users can delete own connected accounts" ON public.connected_accounts;
DROP POLICY IF EXISTS "Users can update own connected accounts" ON public.connected_accounts;
CREATE POLICY "Users can read own connected accounts" ON public.connected_accounts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own connected accounts" ON public.connected_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own connected accounts" ON public.connected_accounts FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Users can update own connected accounts" ON public.connected_accounts FOR UPDATE USING (auth.uid() = user_id);

-- ---- integration_secrets (service role only) ----
CREATE TABLE IF NOT EXISTS public.integration_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);
ALTER TABLE public.integration_secrets ENABLE ROW LEVEL SECURITY;

-- ---- emails ----
CREATE TABLE IF NOT EXISTS public.emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  thread_id TEXT,
  sender TEXT,
  recipients TEXT,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  raw_headers JSONB,
  received_at TIMESTAMPTZ,
  is_read BOOLEAN,
  system_importance NUMERIC DEFAULT 0.5,
  UNIQUE(user_id, gmail_message_id)
);
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own emails" ON public.emails;
DROP POLICY IF EXISTS "Users can delete own emails" ON public.emails;
CREATE POLICY "Users can read own emails" ON public.emails FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own emails" ON public.emails FOR DELETE USING (auth.uid() = user_id);

-- ---- oauth_states ----
CREATE TABLE IF NOT EXISTS public.oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own oauth states" ON public.oauth_states;
DROP POLICY IF EXISTS "Users can insert own oauth states" ON public.oauth_states;
DROP POLICY IF EXISTS "Users can update own oauth states" ON public.oauth_states;
CREATE POLICY "Users can read own oauth states" ON public.oauth_states FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own oauth states" ON public.oauth_states FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own oauth states" ON public.oauth_states FOR UPDATE USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON public.oauth_states(expires_at) WHERE used_at IS NULL;

-- ---- calendar_events ----
CREATE TABLE IF NOT EXISTS public.calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  location TEXT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, google_event_id)
);
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own calendar_events" ON public.calendar_events;
DROP POLICY IF EXISTS "Users can insert own calendar_events" ON public.calendar_events;
DROP POLICY IF EXISTS "Users can update own calendar_events" ON public.calendar_events;
DROP POLICY IF EXISTS "Users can delete own calendar_events" ON public.calendar_events;
CREATE POLICY "Users can read own calendar_events" ON public.calendar_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own calendar_events" ON public.calendar_events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own calendar_events" ON public.calendar_events FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own calendar_events" ON public.calendar_events FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP TABLE IF EXISTS public.calendar_events, public.oauth_states, public.emails,
--   public.integration_secrets, public.connected_accounts, public.profiles CASCADE;
