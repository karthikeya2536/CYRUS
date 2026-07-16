-- runtime-dashboard-queries.sql
-- Queries to monitor the health of Cyrus V2 in real-time

-- 1. Queue depth and job status
SELECT
  job_type,
  status,
  COUNT(*) as count,
  MIN(created_at) as oldest_pending,
  MAX(created_at) as newest
FROM llm_jobs
GROUP BY job_type, status
ORDER BY job_type, status;

-- 2. Recent job failures (last hour)
SELECT
  j.id,
  j.job_type,
  j.user_id,
  j.last_error,
  j.attempts,
  j.max_attempts,
  j.updated_at
FROM llm_jobs j
WHERE j.status = 'failed'
  AND j.updated_at > NOW() - INTERVAL '1 hour'
ORDER BY j.updated_at DESC
LIMIT 20;

-- 3. Worker activity (last 24 hours)
SELECT
  j.job_type,
  COUNT(*) as processed,
  COUNT(*) FILTER (WHERE j.status = 'completed') as successful,
  COUNT(*) FILTER (WHERE j.status = 'permanently_failed') as failed,
  AVG(EXTRACT(EPOCH FROM (j.completed_at - j.started_at))) as avg_duration_seconds
FROM llm_jobs j
WHERE j.updated_at > NOW() - INTERVAL '24 hours'
  AND j.status IN ('completed', 'permanently_failed')
GROUP BY j.job_type;

-- 4. Memory records growth over time (last 7 days)
SELECT
  DATE_TRUNC('day', created_at) as day,
  COUNT(*) as new_memories
FROM memory_records
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY day
ORDER BY day;

-- 5. Sync status (last successful sync per user and provider)
SELECT
  user_id,
  provider,
  last_synced_at,
  status,
  last_sync_error
FROM connected_accounts
WHERE provider IN ('google', 'slack', 'notion')
ORDER BY user_id, provider;

-- 6. Retrieval latency (from retrieval_logs if exists, else approximate from job logs)
-- Assuming we have a retrieval_logs table (from the code we saw earlier)
SELECT
  AVG(latency_ms) as avg_latency_ms,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50_latency_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95_latency_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) as p99_latency_ms,
  COUNT(*) as query_count
FROM retrieval_logs
WHERE created_at > NOW() - INTERVAL '1 hour';

-- 7. Database connections
SELECT
  state,
  COUNT(*) as count
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state;

-- 8. Cache hit ratios (if using pg_stats or pg_statio)
-- This requires the pgstattuple extension or similar; we'll skip for simplicity.

-- 9. Token usage and quota consumption (from increment_usage or usage tracking)
-- Assuming we have a usage table or can query the increment_usage function logs
-- We'll skip as it's application-specific.

-- 10. Error rates in the last hour
SELECT
  COUNT(*) as total_requests,
  COUNT(*) FILTER (WHERE status_code >= 400) as error_requests
-- Note: We don't have a request log table in the provided code.
-- This would need to be implemented in the edge functions or via a proxy.
-- Placeholder:
-- FROM request_logs
-- WHERE timestamp > NOW() - INTERVAL '1 hour';