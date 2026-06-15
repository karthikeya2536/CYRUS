-- Migration: Add OAuth state validation server-side
-- This migration adds the oauth_states table for server-side OAuth state management
-- to prevent CSRF attacks and state replay attacks.

-- Create oauth_states table
CREATE TABLE IF NOT EXISTS public.oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
DROP POLICY IF EXISTS "Users can read own oauth states" ON public.oauth_states;
DROP POLICY IF EXISTS "Users can insert own oauth states" ON public.oauth_states;
DROP POLICY IF EXISTS "Users can update own oauth states" ON public.oauth_states;

CREATE POLICY "Users can read own oauth states" ON public.oauth_states FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own oauth states" ON public.oauth_states FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own oauth states" ON public.oauth_states FOR UPDATE USING (auth.uid() = user_id);

-- Create index for expiring old states
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON public.oauth_states(expires_at) WHERE used_at IS NULL;

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE ON public.oauth_states TO authenticated;
GRANT ALL ON public.oauth_states TO service_role;