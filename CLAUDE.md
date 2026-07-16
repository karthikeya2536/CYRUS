# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cyrus V2 is an AI "second brain" / personal assistant. It syncs a user's Gmail, Google
Calendar, Slack, and Notion into Postgres, extracts durable **memories** from that data
with LLMs, answers natural-language queries via hybrid retrieval, and generates daily
**briefings**. Billing/entitlements are handled through Stripe + a plan system.

The codebase has two halves:
- **Frontend** — a React 19 + Vite SPA (plain JS/JSX, no TypeScript) in `src/`.
- **Backend** — Supabase: Postgres (with RLS + pgvector) plus Deno **edge functions**
  in `supabase/functions/`. There is no separate app server.

## Commands

Frontend (Node, run from repo root):
```bash
npm run dev        # Vite dev server (default http://localhost:5173)
npm run build      # production build to dist/
npm run lint       # eslint (flat config in eslint.config.js)
npm run preview    # serve the built bundle
```

Edge functions (Deno — the CI gates):
```bash
# Type-check one function (CI does this for every supabase/functions/*/index.ts):
deno check supabase/functions/retrieve-context/index.ts

# Run all edge-function tests:
for f in supabase/functions/*/*.test.ts; do deno test --allow-read --allow-net "$f"; done

# Run a single test file:
deno test --allow-read --allow-net supabase/functions/retrieve-context/temporal.test.ts
```

Supabase local stack / migrations:
```bash
supabase start                 # boot local Postgres + studio (applies migrations)
supabase db reset              # strict ordered re-apply of all migrations (what CI validates)
supabase db push               # push migrations to the linked remote project
supabase functions deploy      # deploy all edge functions
# After db reset locally, activate cron + provision Vault secrets:
psql -h localhost -p 54322 -U postgres -d postgres \
  -v project_url='http://host.docker.internal:54321' -v worker_secret='dev-worker-secret' \
  -f scripts/setup-worker.sql
```

Note: there is **no frontend test runner** (no Jest/Vitest). The loose scripts in `tests/`
and the `test-*.{js,mjs,cjs}` / `*.sql` files at the repo root are ad-hoc manual probes,
not a suite. The real automated tests are the Deno tests above.

## CI/CD

`.github/workflows/ci.yml` runs on push/PR to `main`: `npm run build`, `deno check` on
every function, `deno test`, and a full `supabase db reset` + validation SQL
(`scripts/validate-*.sql`). `deploy.yml` triggers **only after CI succeeds** (via
`workflow_run`) and runs `supabase db push` + `supabase functions deploy`. So a broken
migration or failing `deno check` blocks deploy. `rollback.yml` is the manual escape hatch.

## Architecture

### Request → data flow
React pages (`src/pages/`) use hooks (`src/hooks/use*.js`) which call the shared Supabase
client (`src/lib/supabase.js`). Hooks either query tables directly (RLS-protected) or
`supabase.functions.invoke(...)` an edge function. `ProtectedRoute` + `useAuth` gate all
authenticated routes; routing lives in `src/App.jsx`.

### Edge functions (`supabase/functions/`)
- **OAuth**: `create-oauth-state`, `{google,slack,notion}-oauth-exchange`,
  `google-oauth-disconnect`. Tokens are stored in `integration_secrets` (service-role only).
- **Sync**: `gmail-sync`, `calendar-sync`, `slack-sync`, `notion-sync` — pull provider data
  into `emails` / `calendar_events` / `slack_messages` / `notion_pages`.
- **Retrieval**: `retrieve-context` (the query path) with `ranker.ts` + `assembler.ts`;
  `retrieval-feedback` records relevance signals.
- **Async worker**: `llm-worker` drains the `llm_jobs` queue (see below).
- **Producers**: `memory-extraction`, `generate-briefing` enqueue jobs.
- **Billing**: `create-checkout-session`, `stripe-webhook`.
- **Ops**: `health`, `system-validation`.
- **`_shared/`**: cross-cutting modules — `llm-router.ts`, `prompts.ts`, `plans.ts`,
  `cors.ts`, `rateLimit.ts`, `validators.ts`, `temporal.ts`, `query-parser.ts`, `log.ts`.

### Async job system (central pattern)
Long/LLM work is **never** done inline. Producers insert rows into `llm_jobs`
(`job_type` ∈ `memory_extraction` | `briefing_generation` | `generate_embedding`).
`llm-worker` is invoked **every minute by pg_cron via pg_net** and:
- reclaims stale `processing` jobs (5-min cutoff) and dead-letters those past `max_attempts`;
- claims one pending job at a time via optimistic locking (`update ... where status='pending'`);
- processes up to `MAX_JOBS_PER_RUN` (5) per invocation;
- retries on failure, marks `permanently_failed` after `max_attempts`.
When editing the worker, preserve the reclaim → claim → retry → dead-letter invariants.

### LLM routing (`_shared/llm-router.ts`)
All LLM requests go through the `LLMRouter` class, which acts as a thin wrapper over
OmniRoute, the centralized AI gateway. The router provides two main methods:
- `execute(request)`: processes a prompt and returns generated text. The `request` can
  specify a `capacity` (e.g., 'reasoning', 'summarization', 'extraction') to help
  OmniRoute select the appropriate model.
- `generateEmbedding(text)`: returns a 768-dimensional embedding vector using OmniRoute.

This design ensures that no edge function contains provider-specific logic or model names.
All routing, fallback, and provider selection is handled by OmniRoute.

### Memory + retrieval
Sync → enqueue `memory_extraction` → worker extracts candidates, dedups by cosine distance
(`DEDUP_DISTANCE_THRESHOLD`, default 0.15) with LLM adjudication, extracts entities
(`entity_mentions`) for graph hops, and writes `memory_records`. Retrieval combines
`hybrid_search_memories/_emails/_events` RPCs (vector + full-text), `graph_expand_memories`
(≤2 hops), then `ranker.ts` scores and `assembler.ts` builds the context. Comments reference
build "Phases" (e.g. Phase 13 feedback, Phase 14 dedup, Phase 16 graph, C1–C5 auto-sync);
treat these as historical labels.

### Plans & quota (`_shared/plans.ts`)
Plan **state** lives in `subscriptions` (set by `stripe-webhook`); plan **limits** are
hardcoded in `plans.ts` so they change without a migration. No/inactive subscription = `free`.
`consumeQuota()` meters `ai_queries`/`briefings` per day via the `increment_usage` RPC.

## Conventions & gotchas

- **Edge functions are Deno**, not Node: full-URL imports (`https://deno.land/...`,
  `https://esm.sh/...`), `Deno.env.get(...)` for config. Don't import Node libs there.
- **`verify_jwt = false`** in `supabase/config.toml` for `llm-worker`, `gmail-sync`,
  `calendar-sync`, `generate-briefing`, `stripe-webhook`, `memory-extraction` — these
  authenticate **themselves**: `x-worker-secret` (must equal `WORKER_SECRET`) for
  cron/system calls, a user JWT (`getUser`) for UI calls, or Stripe HMAC for the webhook.
  Don't "fix" these to `true`.
- **Migrations** in `supabase/migrations/` are strictly ordered and must be **idempotent**
  (`IF NOT EXISTS`, policy drop-guards) — CI runs a clean `db reset`. There is an active
  directive (see `TECH_DEBT.md`) to **avoid schema changes** unless a task requires one;
  prefer logic changes over new columns/tables.
- **pg_cron + Vault**: schedule migrations (022, 024–026) do *not* hardcode or auto-create
  secrets. They schedule only if Vault secrets `project_url` + `worker_secret` exist;
  otherwise they no-op so `db reset` stays green. Provision via `scripts/setup-worker.sql`.
  `WORKER_SECRET` (edge env) and the Vault `worker_secret` must be identical.
- **Secrets layering**: frontend `VITE_*` go in `.env` (baked into the bundle, public);
  edge-function secrets via `supabase secrets set` (never in `.env`); pg_cron runtime
  secrets in Vault via SQL. See `.env.example` for the full inventory.
- **RLS everywhere**: every user table has per-user policies (`auth.uid() = user_id`).
  Edge functions use the **service-role** key (`supabaseAdmin`) to bypass RLS and must
  therefore filter by `user_id` explicitly. `integration_secrets` is service-role-only.
- **Known deferred bugs** are catalogued in `TECH_DEBT.md` (e.g. sync-failure observability,
  non-atomic extraction dedup). Check it before "discovering" these.

## Tooling

A Supabase MCP server is configured in `.mcp.json`. Installed agent skills (pinned in
`skills-lock.json`, vendored under `.agents/skills/`): `supabase-postgres-best-practices`
and `web-design-guidelines` — consult them for Postgres/RLS/index and UI work.

## gstack

For all web browsing tasks, use the `/browse` skill from gstack. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
- `/office-hours`
- `/plan-ceo-review`
- `/plan-eng-review`
- `/plan-design-review`
- `/design-consultation`
- `/design-shotgun`
- `/design-html`
- `/review`
- `/ship`
- `/land-and-deploy`
- `/canary`
- `/benchmark`
- `/browse`
- `/connect-chrome`
- `/qa`
- `/qa-only`
- `/design-review`
- `/setup-browser-cookies`
- `/setup-deploy`
- `/setup-gbrain`
- `/retro`
- `/investigate`
- `/document-release`
- `/document-generate`
- `/codex`
- `/cso`
- `/autoplan`
- `/plan-devex-review`
- `/devex-review`
- `/careful`
- `/freeze`
- `/guard`
- `/unfreeze`
- `/gstack-upgrade`
- `/learn`