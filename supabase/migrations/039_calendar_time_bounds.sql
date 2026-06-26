-- ============================================
-- Migration: 039_calendar_time_bounds
-- ============================================
-- Adds a 30-day time window constraint to the hybrid_search_events RPC.
-- This ensures retrieve-context only surfaces events from the present out to 30 days,
-- preventing events from 2034 or the distant future from leaking into context.
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
    AND c.start_time >= now()
    AND c.start_time <= now() + interval '30 days'
    AND to_tsvector('english',
      COALESCE(c.title, '') || ' ' || COALESCE(c.description, ''))
      @@ plainto_tsquery('english', query_text)
  ORDER BY similarity_distance ASC
  LIMIT match_count;
END;
$$;
