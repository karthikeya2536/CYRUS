- `memory_extraction_logs` (`014_log_tables.sql`) records every extraction decision but
  is only read by system-validation's cost projection.
- `memory_merge_audit` (`018_memory_dedup.sql`) tracks dedup merges.
- `provider_health` table removed; LLM provider metrics now tracked via `cost_events` table.
- `llm_jobs` (`011:73-99`) is the async queue observability surface but has no
  dashboard, no staleness alert, no throughput metrics.
- `briefings` (`011:123-142`) stores generation metadata + latency but has no
  aggregation view.
- `connected_accounts.last_sync_error` (`029`) captures sync failures but has no
  alerting — a broken Gmail connection is silent until the user checks.
- `rate_limits` (`013`) tracks per-function rate limiting but has no abuse detection.
- `usage_counters` (`017`) meters quota but has no cost projection or anomaly detection.
- `_shared/log.ts` emits structured JSON to stdout but has no transport, aggregation,
  or retention beyond Supabase's built-in Edge Function log viewer.
- `system-validation/index.ts` is the closest thing to a monitoring check — but it
  runs on-demand, not on a schedule.