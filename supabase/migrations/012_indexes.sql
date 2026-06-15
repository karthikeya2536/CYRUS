-- ============================================
-- Migration: Performance indexes
-- ============================================
-- Adds indexes needed by the hybrid search RPCs (008/010) and the worker queue.
-- Expressions match the to_tsvector(...) expressions used in 008 exactly so the
-- planner can use the GIN indexes.

-- ============================================
-- UP
-- ============================================

-- Vector similarity on memory_records.embedding (used by hybrid_search_memories,
-- ORDER BY embedding <=> query_embedding => cosine distance).
CREATE INDEX IF NOT EXISTS idx_memory_records_embedding
  ON public.memory_records
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Full-text search on emails (matches hybrid_search_emails expression).
CREATE INDEX IF NOT EXISTS idx_emails_fts
  ON public.emails
  USING GIN (to_tsvector('english', COALESCE(subject, '') || ' ' || COALESCE(body_text, '')));

-- Full-text search on calendar_events (matches hybrid_search_events expression).
CREATE INDEX IF NOT EXISTS idx_calendar_events_fts
  ON public.calendar_events
  USING GIN (to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '')));

-- Worker queue ordering: WHERE status=... ORDER BY priority, created_at (llm-worker fetch).
CREATE INDEX IF NOT EXISTS idx_llm_jobs_status_priority_created
  ON public.llm_jobs (status, priority, created_at);

-- ============================================
-- ROLLBACK
-- ============================================
-- DROP INDEX IF EXISTS public.idx_llm_jobs_status_priority_created;
-- DROP INDEX IF EXISTS public.idx_calendar_events_fts;
-- DROP INDEX IF EXISTS public.idx_emails_fts;
-- DROP INDEX IF EXISTS public.idx_memory_records_embedding;

-- ============================================
-- VERIFICATION
-- ============================================
--   SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN (
--     'idx_memory_records_embedding','idx_emails_fts',
--     'idx_calendar_events_fts','idx_llm_jobs_status_priority_created'
--   );
