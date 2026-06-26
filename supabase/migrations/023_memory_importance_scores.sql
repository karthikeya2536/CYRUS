-- ============================================
-- Migration: Add memory importance scores
-- ============================================

ALTER TABLE public.memory_records
ADD COLUMN IF NOT EXISTS llm_importance DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS system_importance DOUBLE PRECISION;
