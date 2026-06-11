-- ============================================
-- Phase 1: Profiles table
-- ============================================

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- ============================================
-- Phase 2 & 3: Connected Accounts & Integration Secrets
-- ============================================

CREATE TABLE public.connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_email TEXT,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active', -- 'active' or 'broken'
  UNIQUE(user_id, provider)
);

ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own connected accounts" ON public.connected_accounts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own connected accounts" ON public.connected_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own connected accounts" ON public.connected_accounts FOR DELETE USING (auth.uid() = user_id);
-- Allow users to potentially update status if they re-connect, or just rely on upsert
CREATE POLICY "Users can update own connected accounts" ON public.connected_accounts FOR UPDATE USING (auth.uid() = user_id);

CREATE TABLE public.integration_secrets (
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
-- No RLS policies for integration_secrets (service role only)

-- ============================================
-- Phase 3: Emails table
-- ============================================

CREATE TABLE public.emails (
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
  UNIQUE(user_id, gmail_message_id)
);

ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own emails" ON public.emails FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own emails" ON public.emails FOR DELETE USING (auth.uid() = user_id);
-- Inserts happen via service role in edge function, but if we want to allow it, we can.
-- For now, we rely on the edge function which bypasses RLS anyway.

-- ============================================
-- Phase 4: Calendar Events table
-- ============================================

CREATE TABLE public.calendar_events (
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

CREATE POLICY "Users can read own calendar_events" ON public.calendar_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own calendar_events" ON public.calendar_events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own calendar_events" ON public.calendar_events FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own calendar_events" ON public.calendar_events FOR DELETE USING (auth.uid() = user_id);
