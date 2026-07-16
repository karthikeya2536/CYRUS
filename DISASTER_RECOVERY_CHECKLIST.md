# Disaster Recovery Checklist

## Detection
- [ ] Monitor alerts for system downtime, high error rates, or performance degradation
- [ ] Verify issue is not a false positive by checking multiple metrics and logs
- [ ] Determine scope: Is it affecting all users, a subset, or specific features?

## Initial Response
- [ ] Acknowledge the incident and notify the on-call engineer and stakeholders
- [ ] Assign an incident manager to coordinate the response
- [ ] Establish a communication channel (e.g., dedicated Slack channel, Zoom call)
- [ ] Start an incident timeline document

## Diagnosis
- [ ] Check the status of all external dependencies:
  - Supabase (database and API)
  - Google API (Gmail, Calendar)
  - Slack API
  - Notion API
  - OmniRoute (if applicable)
- [ ] Review application logs for errors and stack traces
- [ ] Check database status:
  - Connection count
  - Replication lag (if applicable)
  - Long-running queries
  - Lock contention
- [ ] Check queue status:
  - Number of pending jobs
  - Number of failed jobs
  - Worker processing rate
- [ ] Check host-level metrics:
  - CPU usage
  - Memory usage
  - Disk I/O
  - Network throughput
- [ ] Verify DNS and load balancer configuration

## Mitigation
Based on the diagnosed issue, apply the appropriate mitigation:

### If the issue is with the application code (edge functions):
- [ ] Roll back to the previous known-good version
- [ ] If rolling back is not possible, consider disabling the problematic feature via feature flag
- [ ] Clear any problematic queues if safe to do so (e.g., retrying failed jobs after fix)

### If the issue is with the database:
- [ ] Check for long-running queries and cancel them if safe
- [ ] If the database is unresponsive, consider failing over to a replica (if configured)
- [ ] If data corruption is suspected, restore from the most recent clean backup

### If the issue is with external services:
- [ ] Check the status page of the external service (Google Cloud Status, etc.)
- [ ] If the service is degraded, implement rate limiting or fallback mechanisms if available
- [ ] For rate limiting (429), ensure the client-side backoff is working correctly
- [ ] If the service is unavailable, consider switching to a degraded mode (e.g., skip syncing until service recovers)

### If the issue is with infrastructure:
- [ ] Restart affected services (e.g., restart the worker containers if using a container platform)
- [ ] Scale out if the issue is resource exhaustion
- [ ] Check for and resolve any network partitioning

## Recovery
- [ ] Once the immediate issue is resolved, verify that the system is functioning correctly:
  - Run smoke tests on critical paths
  - Check that queues are draining and not backing up
  - Confirm that error rates have returned to baseline
  - Validate that latency metrics are normal
- [ ] If data loss occurred, initiate recovery from backups
- [ ] If data corruption occurred, repair using available tools or restore from backup
- [ ] Monitor closely for recurrence

## Post-Incident
- [ ] Conduct a post-mortem meeting within 48 hours
- [ ] Update the incident timeline with all actions taken
- [ ] Identify the root cause and contributing factors
- [ ] Generate action items to prevent recurrence (e.g., improve monitoring, add guards, refactor code)
- [ ] Update runbooks and documentation based on lessons learned
- [ ] Close the incident and communicate resolution to stakeholders

## Specific Scenarios

### Database Corruption or Loss
1. Do not write to the database further to prevent additional corruption
2. Identify the point of failure using logs and backup timestamps
3. Restore the database from the most recent clean backup
4. Apply any pending migrations if necessary
5. Bring the application back online in read-only mode initially to verify integrity
6. Gradually resume normal operations

### Prolonged External Service Outage
1. Switch to degraded mode where possible (e.g., disable syncing for the affected service)
2. Notify users if the functionality is temporarily unavailable
3. Queue up changes that would have been synced and process them when the service returns
4. Monitor the service provider's status page for updates

### Complete Site Outage
1. Failover to a secondary region if available (requires multi-region setup)
2. If not available, restore from backups in a new environment
3. Update DNS to point to the new environment
4. Notify users of the outage and expected restoration time

### Data Breach or Security Incident
1. Isolate affected systems immediately
2. Preserve logs and evidence for forensic analysis
3. Engage the security team and follow the incident response plan
4. Notify affected users and regulators as required by law
5. Rotate all potentially compromised secrets
6. Patch any vulnerabilities that were exploited

## Communication Templates
### Initial Notification
> "We are currently investigating an issue affecting [service]. Our team is working to identify and resolve the problem. We will provide updates every [time interval]."

### Update During Incident
> "We have identified [cause] and are implementing [fix]. We expect service to be restored by [time]. Please continue to monitor [status page] for updates."

### Resolution Notification
> "The issue has been resolved. Service is now operating normally. We apologize for any inconvenience caused and are taking steps to prevent a recurrence. A post-mortem will be conducted and shared."

## Contacts
- [ ] On-call engineer: [Name, Phone, Email]
- [ ] Engineering lead: [Name, Phone, Email]
- [ ] Product manager: [Name, Phone, Email]
- [ ] Security officer: [Name, Phone, Email] (if applicable)
- [ ] Vendor contacts (Google Cloud Support, Supabase Support, etc.)