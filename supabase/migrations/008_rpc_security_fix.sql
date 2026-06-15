-- ============================================
-- Migration: Fix RPC Security - Remove user_id Param, Enforce auth.uid()
-- ============================================
-- This migration fixes the data leakage vulnerability where:
-- 1. The Edge Function was accepting attacker-controlled user_id (NOW FIXED)
-- 2. The SQL RPCs still accepted user_id as a parameter
--
-- This fix removes user_id from RPC signatures and enforces auth.uid() internally.
--
-- IMPORTANT: Adjust column names to match your actual schema (embedding, content, etc.)
--
-- Run via Supabase SQL editor: supabase db push

-- ============================================
-- Step 1: Drop existing functions (if any)
-- ============================================

DROP FUNCTION IF EXISTS public.hybrid_search_memories(TEXT, vector, INTEGER);
DROP FUNCTION IF EXISTS public.hybrid_search_emails(TEXT, vector, INTEGER);
DROP FUNCTION IF EXISTS public.hybrid_search_events(TEXT, vector, INTEGER);

-- ============================================
-- Step 2: Create hybrid_search_memories
-- ============================================
-- NOTE: Modify column names (content, memory_type, embedding) to match your memories table
-- If you don't have a memories table, skip this function

CREATE OR REPLACE FUNCTION public.hybrid_search_memories(
  query_text TEXT,
  query_embedding vector(768),
  match_count INTEGER DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  user_id UUID,
  memory_type TEXT,
  created_at TIMESTAMPTZ,
  similarity_distance FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.user_id,
    m.memory_type,
    m.created_at,
    m.embedding <=> query_embedding AS similarity_distance
  FROM public.memories m
  WHERE m.user_id = auth.uid()  -- ENFORCE USER ISOLATION
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================
-- Step 3: Create hybrid_search_emails
-- ============================================
-- Modify column names if different: subject, body_text, snippet

CREATE OR REPLACE FUNCTION public.hybrid_search_emails(
  query_text TEXT,
  query_embedding vector(768),
  match_count INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  sender TEXT,
  recipients TEXT,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  received_at TIMESTAMPTZ,
  similarity_distance FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.user_id,
    e.sender,
    e.recipients,
    e.subject,
    e.snippet,
    e.body_text,
    e.received_at,
    -- If emails has embedding column:
    -- e.embedding <=> query_embedding AS similarity_distance
    -- Otherwise use text search:
    1.0 - ts_rank(to_tsvector('english',
      COALESCE(e.subject, '') || ' ' || COALESCE(e.body_text, '')),
      plainto_tsquery('english', query_text)) AS similarity_distance
  FROM public.emails e
  WHERE e.user_id = auth.uid()  -- ENFORCE USER ISOLATION
    AND to_tsvector('english',
      COALESCE(e.subject, '') || ' ' || COALESCE(e.body_text, ''))
      @@ plainto_tsquery('english', query_text)
  ORDER BY similarity_distance DESC
  LIMIT match_count;
END;
$$;

-- ============================================
-- Step 4: Create hybrid_search_events
-- ============================================

CREATE OR REPLACE FUNCTION public.hybrid_search_events(
  query_text TEXT,
  query_embedding vector(768),
  match_count INTEGER DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  google_event_id TEXT,
  title TEXT,
  description TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  location TEXT,
  similarity_distance FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.user_id,
    c.google_event_id,
    c.title,
    c.description,
    c.start_time,
    c.end_time,
    c.location,
    1.0 - ts_rank(to_tsvector('english',
      COALESCE(c.title, '') || ' ' || COALESCE(c.description, '')),
      plainto_tsquery('english', query_text)) AS similarity_distance
  FROM public.calendar_events c
  WHERE c.user_id = auth.uid()  -- ENFORCE USER ISOLATION
    AND to_tsvector('english',
      COALESCE(c.title, '') || ' ' || COALESCE(c.description, ''))
      @@ plainto_tsquery('english', query_text)
  ORDER BY similarity_distance DESC
  LIMIT match_count;
END;
$$;

-- ============================================
-- Step 5: Grant execute permissions
-- ============================================
-- Postgres grants EXECUTE to PUBLIC by default on function creation, and anon
-- is a member of PUBLIC. Revoke that implicit grant first, then grant only to
-- authenticated, so unauthenticated callers cannot invoke these RPCs.

-- Supabase also auto-grants EXECUTE to anon via ALTER DEFAULT PRIVILEGES, so
-- anon must be revoked explicitly in addition to PUBLIC.
REVOKE EXECUTE ON FUNCTION public.hybrid_search_memories(TEXT, vector, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_emails(TEXT, vector, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_events(TEXT, vector, INTEGER) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.hybrid_search_memories TO authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_emails TO authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_events TO authenticated;