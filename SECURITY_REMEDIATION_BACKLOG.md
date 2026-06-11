# Security Remediation Backlog - Consolidated from 3 Audits

**Document Version:** 1.0
**Generated:** 2026-06-11
**Source Audits:** 3 separate security audit reports

---

## Executive Summary

| Priority | Count | Description |
|----------|-------|-------------|
| **P0** | 8 | Must fix before production |
| **P1** | 10 | Fix within first release |
| **P2** | 6 | Technical debt |

**Application Health Score:** 38/100
**Production Readiness:** Not Ready for Production

---

# P0 - Must Fix Before Production

## P0-01: Hardcoded Secrets in Source Control [.env file committed]
- **Severity:** Critical
- **Business Impact:** Full compromise of Supabase project, all LLM provider accounts, Google OAuth credentials. Attackers can access all user data, modify database, incur costs on LLM APIs.
- **Engineering Effort:** Low - Remove .env from git, rotate all exposed credentials immediately
- **Risk Reduction Score:** 10/10
- **Exact Files Affected:**
  - `.env` (committed with real credentials)
  - `src/lib/supabase.js` (reads .env)
  - `supabase/functions/_shared/llm-router.ts` line 5 (fallback key `'apf_sl19b4jb5p5ss1j89avd1dis'`)
  - All test scripts referencing env vars
- **Merged From:** C-01, C-02, C-08, Audit 2 Finding 1, Audit 2 Finding 3

## P0-02: No Encryption at Rest for OAuth Tokens
- **Severity:** Critical
- **Business Impact:** Database compromise exposes all user Google tokens. Tokens stored as plain TEXT. Full account takeover possible.
- **Engineering Effort:** Medium - Implement App-layer encryption or use Supabase Vault
- **Risk Reduction Score:** 10/10
- **Exact Files Affected:**
  - `schema.sql:46-56` (integration_secrets table)
  - `supabase/functions/google-oauth-exchange/index.ts` (token storage)
  - `supabase/functions/gmail-sync/index.ts:141-146`
  - `supabase/functions/calendar-sync/index.ts:49-54`
- **Merged From:** C-03, C-04, Audit 2 Finding 4

## P0-03: CORS Wildcard on All Edge Functions
- **Severity:** Critical
- **Business Impact:** Any website can make authenticated requests to edge functions. CSRF-like attacks possible. User visits malicious site = automatic API calls with user's session.
- **Engineering Effort:** Low - Change `Access-Control-Allow-Origin: *` to specific origin
- **Risk Reduction Score:** 10/10
- **Exact Files Affected:**
  - ALL edge functions (8 functions): `memory-extraction/index.ts`, `retrieve-context/index.ts`, `gmail-sync/index.ts`, `calendar-sync/index.ts`, `google-oauth-exchange/index.ts`, `google-oauth-disconnect/index.ts`, `llm-worker/index.ts`, `generate-briefing/index.ts`, `system-validation/index.ts`
- **Merged From:** C-06, Audit 2 Finding 5, Audit 3 Finding 2

## P0-04: No RLS Policies on integration_secrets Table
- **Severity:** Critical
- **Business Impact:** If RLS is accidentally disabled, all OAuth tokens exposed. Only service_role can access, but service_role key is exposed (P0-01).
- **Engineering Effort:** Low - Add RLS policies even for service-only tables as defense in depth
- **Risk Reduction Score:** 9/10
- **Exact Files Affected:**
  - `schema.sql:58-59` (integration_secrets table definition)
- **Merged From:** C-04

## P0-05: No RLS Policy on emails Table (Missing SELECT Policy)
- **Severity:** Critical
- **Business Impact:** Users cannot read their own emails - SELECT policy missing. Bypass via service role but breaks tenant isolation.
- **Engineering Effort:** Low - Add RLS SELECT policy for user_id match
- **Risk Reduction Score:** 9/10
- **Exact Files Affected:**
  - `schema.sql:87-92` (emails table)
- **Merged From:** Audit 2 Finding 4

## P0-06: OAuth State Validation Client-Side Only
- **Severity:** Critical
- **Business Impact:** OAuth flow vulnerable to state injection/replay attacks. State stored in localStorage, not cryptographically bound. Client-side only validation.
- **Engineering Effort:** Medium - Add server-side state validation in google-oauth-exchange
- **Risk Reduction Score:** 9/10
- **Exact Files Affected:**
  - `src/pages/GoogleCallback.jsx`
  - `src/hooks/useConnectedAccounts.js`
  - `supabase/functions/google-oauth-exchange/index.ts`
- **Merged From:** C-05, Audit 2 Finding 8, Audit 3 Finding 4

## P0-07: Client-Provided redirect_uri in OAuth Exchange (No Allowlist)
- **Severity:** Critical
- **Business Impact:** OAuth authorization code can be exchanged using different redirect_uri. Enables authorization code interception attacks.
- **Engineering Effort:** Medium - Validate redirect_uri against allowlist
- **Risk Reduction Score:** 9/10
- **Exact Files Affected:**
  - `supabase/functions/google-oauth-exchange/index.ts:21-24`
- **Merged From:** H-02, Audit 2 Finding 1, Audit 3 Finding 1

## P0-08: No Rate Limiting on Any Edge Function
- **Severity:** Critical (per High in some audits, elevated to Critical)
- **Business Impact:** Unlimited API calls possible. DoS attacks, cost explosion on LLM APIs, brute force on auth endpoints. Attackers can inundate Google API rate limits affecting all users.
- **Engineering Effort:** Medium - Implement per-user/per-IP rate limiting middleware
- **Risk Reduction Score:** 9/10
- **Exact Files Affected:**
  - ALL edge functions
- **Merged From:** H-05, Audit 2 Finding 6

---

# P1 - Fix Within First Release

## P1-01: No Input Validation/Sanitization on User Content in LLM Prompts
- **Severity:** High
- **Business Impact:** Prompt injection attacks possible. Malicious email content could manipulate memory extraction, briefing generation.
- **Engineering Effort:** Medium - Sanitize user content before LLM prompts
- **Risk Reduction Score:** 8/10
- **Exact Files Affected:**
  - `supabase/functions/_shared/prompts.ts`
  - `supabase/functions/llm-worker/index.ts:82-85`
  - `supabase/functions/_shared/query-parser.ts:474-476`
  - `supabase/functions/retrieve-context/index.ts:58-60`
- **Merged From:** H-04, Audit 2 Finding 7

## P1-02: User ID from Client Trusted in retrieve-context
- **Severity:** High
- **Business Impact:** Any authenticated user can retrieve data for any other user by manipulating user_id parameter. Retrieval logs can be poisoned.
- **Engineering Effort:** Low - Verify user_id from JWT claims, not request body
- **Risk Reduction Score:** 8/10
- **Exact Files Affected:**
  - `supabase/functions/retrieve-context/index.ts:18-24`
- **Merged From:** H-01, Audit 3 Finding 6

## P1-03: No Input Size Limits on Edge Functions
- **Severity:** High
- **Business Impact:** DoS via large payloads. Memory exhaustion, timeouts, excessive LLM API costs.
- **Engineering Effort:** Low - Add request body size limits
- **Risk Reduction Score:** 7/10
- **Exact Files Affected:**
  - All edge functions accepting JSON bodies
  - `supabase/functions/retrieve-context/index.ts:18`
  - `supabase/functions/gmail-sync/index.ts:17-35`
- **Merged From:** H-03, M-03

## P1-04: Error Messages Leak Internal Details
- **Severity:** High
- **Business Impact:** Information disclosure about internal architecture, API limits, configuration via stack traces and error messages.
- **Engineering Effort:** Low - Return generic error messages, log details server-side
- **Risk Reduction Score:** 7/10
- **Exact Files Affected:**
  - `supabase/functions/calendar-sync/index.ts:227`
  - `supabase/functions/gmail-sync/index.ts:225`
  - All edge functions returning `500` errors
- **Merged From:** H-06, M-22

## P1-05: Missing Database Indexes on Foreign Keys
- **Severity:** High (Architecture)
- **Business Impact:** Full table scans on every query. Performance degrades severely at scale.
- **Engineering Effort:** Medium - Add indexes on user_id for all tables
- **Risk Reduction Score:** 7/10
- **Exact Files Affected:**
  - `schema.sql` - emails, calendar_events, memory_records, llm_jobs tables
- **Merged From:** Audit 2 Finding 6

## P1-06: No Transaction Safety in Sync Functions
- **Severity:** High
- **Business Impact:** Partial sync failures leave inconsistent state. Duplicate events possible.
- **Engineering Effort:** Medium - Wrap multi-step ops in database transactions
- **Risk Reduction Score:** 7/10
- **Exact Files Affected:**
  - `supabase/functions/gmail-sync/index.ts:149-205`
  - `supabase/functions/calendar-sync/index.ts`
- **Merged From:** Audit 2 Finding 7

## P1-07: Token Refresh Failure Marks Account Permanently Broken
- **Severity:** High
- **Business Impact:** Single transient failure permanently breaks OAuth connection. Users forced to reconnect. No retry mechanism.
- **Engineering Effort:** Medium - Add retry logic with backoff before marking broken
- **Risk Reduction Score:** 7/10
- **Exact Files Affected:**
  - `supabase/functions/calendar-sync/index.ts:111-118`
  - `supabase/functions/gmail-sync/index.ts:113-120`
- **Merged From:** L-07, Audit 3 Finding 7

## P1-08: Circuit Breaker Logic Too Weak
- **Severity:** High
- **Business Impact:** Providers not properly isolated. Single success resets failure count. Flapping providers cause repeated failures.
- **Engineering Effort:** Medium - Use consecutive failure count, proper cooldown
- **Risk Reduction Score:** 6/10
- **Exact Files Affected:**
  - `supabase/functions/_shared/llm-router.ts:46-74`
- **Merged From:** Audit 2 Finding 12

## P1-09: Race Condition in LLM Job Processing
- **Severity:** Medium (elevated to High)
- **Business Impact:** Multiple workers could claim same job. Job duplication possible. Resource waste.
- **Engineering Effort:** Medium - Use SELECT FOR UPDATE or distributed lock
- **Risk Reduction Score:** 6/10
- **Exact Files Affected:**
  - `supabase/functions/llm-worker/index.ts:389-404`
- **Merged From:** M-04, Audit 2 Finding 9

## P1-10: Memory_extraction_logs Table Lacks RLS
- **Severity:** High
- **Business Impact:** Any authenticated user can read/modify extraction logs for all users. Source IDs may leak what content is processed.
- **Engineering Effort:** Low - Enable RLS on memory_extraction_logs
- **Risk Reduction Score:** 6/10
- **Exact Files Affected:**
  - `schema.sql:211-219`
- **Merged From:** H-07

---

# P2 - Technical Debt

## P2-01: Inconsistent Authentication Patterns (verify_jwt = false)
- **Severity:** Medium
- **Business Impact:** Inconsistent security posture. Maintenance burden. Potential gaps.
- **Engineering Effort:** Low - Standardize auth approach across all functions
- **Risk Reduction Score:** 5/10
- **Exact Files Affected:**
  - `supabase/config.toml` (memory-extraction verify_jwt = false)
- **Merged From:** M-01, M-02

## P2-02: No Health Check Endpoints
- **Severity:** Medium
- **Business Impact:** Cannot properly implement zero-downtime deployments, auto-scaling, or circuit breaking.
- **Engineering Effort:** Low - Add /health GET endpoints
- **Risk Reduction Score:** 5/10
- **Exact Files Affected:**
  - All edge functions
- **Merged From:** L-06

## P2-03: Missing Security Headers
- **Severity:** Medium
- **Business Impact:** Reduced browser-side protections against XSS, clickjacking, MIME sniffing.
- **Engineering Effort:** Low - Add CSP, X-Frame-Options, etc. headers
- **Risk Reduction Score:** 5/10
- **Exact Files Affected:**
  - All edge functions
- **Merged From:** Audit 2 Finding 15

## P2-04: Console Logging Instead of Structured Logging
- **Severity:** Low
- **Business Impact:** Difficult to search/alert on logs. Weak observability.
- **Engineering Effort:** Low - Use structured logger
- **Risk Reduction Score:** 4/10
- **Exact Files Affected:**
  - All edge functions
- **Merged From:** L-06

## P2-05: Duplicate Code - Multiple Schema Application Scripts
- **Severity:** Low
- **Business Impact:** Confusion about which script to run. Deployment risk.
- **Engineering Effort:** Low - Consolidate to single script
- **Risk Reduction Score:** 3/10
- **Exact Files Affected:**
  - `apply_schema.js`, `apply-schema.js`, `apply-function.js`
- **Merged From:** L-03

## P2-06: Token Refresh Code Duplicated
- **Severity:** Low
- **Business Impact:** Maintenance burden. Bug fixes must be applied in multiple places.
- **Engineering Effort:** Medium - Extract to shared function
- **Risk Reduction Score:** 3/10
- **Exact Files Affected:**
  - `supabase/functions/gmail-sync/index.ts:155-212`
  - `supabase/functions/calendar-sync/index.ts:60-118`
- **Merged From:** M-24

---

# Deduplication Notes

## Items Removed (Hallucinations or Out of Scope)

1. **SQL Injection Risk in Hybrid Search** - Audit 2 Finding 10 identified potential SQL injection in `websearch_to_tsquery`, but this is handled by PostgreSQL's built-in parameterization. Kept as Low priority due to user input in RPC.

2. **Test-Nim Function Exposes API Key in URL** - Unique to Audit 2, merged into P0-01 (secrets exposure)

3. **Missing Content-Type Validation** - Low risk, runtime handles correctly

4. **No MFA Enforcement** - Supabase-level config, not code issue

5. **No Database Migration Strategy** - Informational, not security

6. **Commented Code Left In** - Code quality

7. **Magic Numbers** - Code quality

---

# Scoring Methodology

| Score | Definition |
|-------|------------|
| 10/10 | Immediate threat - exploit in wild or trivial to exploit |
| 8-9/10 | High impact if exploited, moderate effort to fix |
| 5-7/10 | Moderate impact, standard engineering effort |
| 3-4/10 | Low impact or significant effort to fix |
| 1-2/10 | Informational