-- ============================================
-- Migration: 027_fix_email_event_search_ordering
-- ============================================
-- 008 defined hybrid_search_emails / hybrid_search_events with
--   similarity_distance = 1.0 - ts_rank(...)
-- (smaller distance = better match) but ordered `ORDER BY similarity_distance DESC`,
-- which returns the LEAST relevant rows first and LIMIT truncates to the worst
-- matches. ranker.ts interprets the score as `1 - similarity_distance`, expecting
-- smaller-is-better. This migration recreates both functions with `ASC` so the
-- best matches are returned. Function signatures, columns and grants are
-- unchanged (CREATE OR REPLACE preserves existing EXECUTE grants).
-- No schema change.
-- ============================================

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
    1.0 - ts_rank(to_tsvector('english',
      COALESCE(e.subject, '') || ' ' || COALESCE(e.body_text, '')),
      plainto_tsquery('english', query_text)) AS similarity_distance
  FROM public.emails e
  WHERE e.user_id = auth.uid()  -- ENFORCE USER ISOLATION
    AND to_tsvector('english',
      COALESCE(e.subject, '') || ' ' || COALESCE(e.body_text, ''))
      @@ plainto_tsquery('english', query_text)
  ORDER BY similarity_distance ASC
  LIMIT match_count;
END;
$$;

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
  ORDER BY similarity_distance ASC
  LIMIT match_count;
END;
$$;
