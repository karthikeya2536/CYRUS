# Production Deployment Checklist

## Pre-Deployment

### Code
- [ ] All code changes have been reviewed and approved
- [ ] No new dependencies introduced without security review
- [ ] All Deno tests pass (`deno test` for all edge functions)
- [ ] TypeScript checks pass (`deno check` for all edge functions)
- [ ] Database migrations are backward-compatible and idempotent
- [ ] Migrations have been tested on a staging copy of production data

### Configuration
- [ ] Environment variables are set correctly in the target environment:
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `WORKER_SECRET` (must match the vault secret)
  - `OMNiroute` configuration (if applicable)
  - Feature flags (e.g., `GRAPH_BUILD_ENABLED`, `DEDUP_DISTANCE_THRESHOLD`)
- [ ] Rate limits are set appropriately for the expected load
- [ ] CORS settings are correct for the frontend domain
- [ ] Logging levels are set to `info` or higher in production

### Database
- [ ] All migrations have been applied to the target database
- [ ] Backup of the current database has been taken
- [ ] Replication lag is within acceptable limits (if using read replicas)
- [ ] Connection pool settings are configured for expected load

### Monitoring and Alerting
- [ ] Health check endpoints are operational
- [ ] Log aggregation is configured (e.g., via Loki, Elasticsearch, or cloud logging)
- [ ] Metrics collection is enabled (Prometheus node exporter, etc.)
- [ ] Alerts are configured for:
  - High error rates (5xx)
  - High latency (p99 > threshold)
  - Queue depth exceeding threshold
  - Worker failure rate
  - Database connection exhaustion
  - Disk space low
  - Memory usage high

### Performance
- [ ] Load testing has been performed at expected peak load
- [ ] Soak testing has been run for at least 1 hour to check for leaks
- [ ] Cache warming strategies are in place if applicable

### Security
- [ ] All secrets are stored in the secret manager (Vault) and not in code
- [ ] Regular secret rotation schedule is in place
- [ ] Firewall rules restrict access to necessary IPs only
- [ ] SSL/TLS certificates are valid and not expiring soon
- [ ] Dependencies are scanned for known vulnerabilities

## Deployment

### Deployment Process
- [ ] Deploy during a low-traffic window if possible
- [ ] Use blue/green or rolling update strategy to minimize downtime
- [ ] Have a rollback plan ready

### Steps
1. [ ] Notify stakeholders of deployment start time
2. [ ] Deploy new code to edge functions via `supabase functions deploy`
3. [ ] Run database migrations via `supabase db push` or equivalent
4. [ ] Run smoke tests against the deployed endpoints
5. [ ] Monitor key metrics for anomalies
6. [ ] If all clear, mark deployment as successful
7. [ ] If issues, initiate rollback procedure

### Post-Deployment
- [ ] Run smoke tests to verify core functionality
- [ ] Check logs for any errors
- [ ] Monitor metrics for 30 minutes to ensure stability
- [ ] Notify stakeholders of deployment completion

## Rollback Procedure
- [ ] Have the previous version of the code ready to redeploy
- [ ] If database migrations are not backward-compatible, have a plan to restore from backup
- [ ] Follow the same deployment process in reverse