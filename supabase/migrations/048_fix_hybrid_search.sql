-- ============================================
-- Migration: Fix hybrid search for emails and events to use true hybrid (vector + text) search
-- ============================================
-- This migration updates hybrid_search_emails and hybrid_search_events to use both
-- embedding vector search and full-text search, combining the scores for better relevance.
-- This matches the pattern established in hybrid_search_memories which uses vector search.
--
-- For email and event search, we combine:
--   1. Vector search: embedding <=> query_embedding (lower = better)
--   2. Text search: 1.0 - ts_rank(...) (lower = better)
-- We take the average of these two scores for the final similarity_distance.

-- ============================================
-- Update hybrid_search_emails
-- ============================================

DROP FUNCTION IF EXISTS public.hybrid_search_emails(TEXT, vector, INTEGER);

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
    -- Combine vector and text search scores (average)
    (
      (e.embedding <=> query_embedding) +
      (1.0 - ts_rank(to_tsvector('english',
        COALESCE(e.subject, '') || ' ' || COALESCE(e.body_text, '')),
        plainto_tsquery('english', query_text)))
    ) / 2.0 AS similarity_distance
  FROM public.emails e
  WHERE e.user_id = auth.uid()  -- ENFORCE USER ISOLATION
    AND to_tsvector('english',
      COALESCE(e.subject, '') || ' ' || COALESCE(e.body_text, ''))
      @@ plainto_tsquery('english', query_text)
  ORDER BY similarity_distance ASC
  LIMIT match_count;
END;
$$;

-- ============================================
-- Update hybrid_search_events
-- ============================================

DROP FUNCTION IF EXISTS public.hybrid_search_events(TEXT, vector, INTEGER);

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
    -- Combine vector and text search scores (average)
    (
      (c.embedding <=> query_embedding) +
      (1.0 - ts_rank(to_tsvector('english',
        COALESCE(c.title, '') || ' ' || COALESCE(c.description, '')),
        plainto_tsquery('english', query_text)))
    ) / 2.0 AS similarity_distance
  FROM public.calendar_events c
  WHERE c.user_id = auth.uid()  -- ENFORCE USER ISOLATION
    AND to_tsvector('english',
      COALESCE(c.title, '') || ' ' || COALESCE(c.description, ''))
      @@ plainto_tsquery('english', query_text)
  ORDER BY similarity_distance ASC
  LIMIT match_count;
END;
$$;

-- ============================================
-- Set permissions
-- ============================================

REVOKE EXECUTE ON FUNCTION public.hybrid_search_emails(TEXT, vector, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.hybrid_search_events(TEXT, vector, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_emails TO authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_events TO authenticated;

-- ============================================
-- Verification
-- ============================================
-- After applying, confirm the functions use both signals:
--   SELECT * FROM public.hybrid_search_emails(
--     'test query',
--     ('[' || array_to_string(array_fill(0::float, ARRAY[768]), ',') || ']')::vector,
--     5
--   ) LIMIT 1;
-- (Run as an authenticated user; returns only that user's email records.)
--
--   SELECT * FROM public.hybrid_search_events(
--     'test meeting',
--     ('[' || array_to_string(array_fill(0::float, ARRAY[768]), ',') || ']')::vector,
--     5
--   ) LIMIT 1;
-- (Run as an authenticated user; returns only that user's event records.)