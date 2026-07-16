# OmniRoute Production-Readiness Audit

**Date:** 2026-07-03
**Auditor:** Principal AI Infrastructure Engineer (automated)
**Status:** Complete — All 14 phases evaluated (Phase 3 uses local OmniRoute instance)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cyrus Edge Functions                          │
│                                                                 │
│  retrieve-context    llm-worker     query-parser                 │
│       │                  │               │                       │
│       │                  │               │                       │
│       ▼                  ▼               ▼                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │                  LLMRouter                              │     │
│  │  ┌────────────────────────────────────────────────────┐ │     │
│  │  │  callOmniRoute(endpoint, payload)                  │ │     │
│  │  │  • /v1/completions  (LLM calls)                    │ │     │
│  │  │  • /v1/embeddings   (embeddings)                   │ │     │
│  │  │  • Bearer auth   • AbortController timeout         │ │     │
│  │  │  • MISSING: stream: false  (see Finding 3.1)       │ │     │
│  │  └────────────────────────────────────────────────────┘ │     │
│  └────────────────────────────────────────────────────────┘     │
│                         │                                        │
└─────────────────────────┼────────────────────────────────────────┘
                          │ HTTPS / VPC-internal
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OmniRoute Gateway v3.8.42                     │
│                                                                  │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐     │
│  │  Groq    │   │    OC    │   │  Cohere  │   │  Mistral  │     │
│  │(combo)   │   │(reason)  │   │(embed)   │   │(embed)    │     │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘     │
│                                                                  │
│  Available: 21 LLM models, 17 embedding models                   │
│  Default output: SSE streaming (text/event-stream)               │
└─────────────────────────────────────────────────────────────────┘
```

**LLM callers (all through LLMRouter):**

| Caller | Operation | Endpoint | Frequency |
|--------|-----------|----------|-----------|
| `query-parser.ts:64` | Intent classification | `/v1/completions` | Every retrieval query |
| `retrieve-context/index.ts:140` | Query embedding | `/v1/embeddings` | Every retrieval query |
| `llm-worker` memory extraction | Memory content extraction | `/v1/completions` | Per memory-extraction job |
| `llm-worker` verification | Memory verification | `/v1/completions` | Per candidate memory |
| `llm-worker` dedup adjudication | Duplicate determination | `/v1/completions` | Per dedup candidate |
| `llm-worker` graph construction | Entity/edge extraction | `/v1/completions` | Per memory | 
| `llm-worker` briefing draft | Briefing generation | `/v1/completions` | Per briefing job |
| `llm-worker` briefing verify | Briefing quality check | `/v1/completions` | Per briefing |

---

## Phase 1 — Static Architecture Audit

### ✅ Verified: All LLM requests flow through LLMRouter → OmniRoute

Every LLM call in every edge function uses one of these:
- `LLMRouter.execute()` — chat/completion requests
- `LLMRouter.generateEmbedding()` — embedding requests

**No** direct provider SDK imports — confirmed zero matches for `openai`, `anthropic`, `cohere`, `gpt-`, `claude`, `gemini` outside of comments.

**No** direct provider HTTP calls — every call goes through `callOmniRoute()`.

**No** provider-specific routing logic — the `capability` field is passed opaque to OmniRoute.

**No** hidden bypasses — checked all files under `supabase/functions/` and `_shared/`.

**No** legacy adapters — `provider_health` table and all legacy provider tracking code have been removed. Verified: provider_health table was cleanly dropped in migration `20260627000239_drop_provider_health.sql`, no references remain in code.

### ⚠️ Gap: Zero test coverage for LLMRouter

The router has no unit tests. 5 test files exist in the project (`graph-eval.test.ts`, `ranking.test.ts`, `benchmark.test.ts`, `metrics.test.ts`, `temporal.test.ts`) but none exercise `llm-router.ts`. The router's timeout, error handling, response parsing, and retry logic are untested.

---

## Phase 2 — Configuration Audit

### ✅ Configuration surface

| Variable | Type | Default | Used In |
|----------|------|---------|---------|
| `OMNIROUTE_BASE_URL` | Required | — | `callOmniRoute()` |
| `OMNIROUTE_API_KEY` | Required | — | Auth header |
| `OMNIROUTE_DEFAULT_MODEL` | Optional (see finding) | `""` | Completion requests |
| `OMNIROUTE_EMBEDDING_MODEL` | Optional (see finding) | `""` | Embedding requests |
| `OMNIROUTE_TIMEOUT` | Optional | `10000` | AbortController |

### ⚠️ Finding 2.1: Empty model defaults

Both `OMNIROUTE_DEFAULT_MODEL` and `OMNIROUTE_EMBEDDING_MODEL` default to empty string via `|| ''`. If not configured, OmniRoute receives a `model: ""` payload. Some OmniRoute configurations may reject this or silently use a default model that differs from what the code expects (especially for embedding dimension compatibility).

**Evidence:** `llm-router.ts:94,158`
```typescript
model: Deno.env.get('OMNIROUTE_DEFAULT_MODEL') || '',
```

**Runtime verification:** Sending `model: ""` to `/v1/completions` returns **400 Bad Request**: content-type `application/json`. LLMRouter throws `HTTP_400`.

### ⚠️ Finding 2.2: `max_tokens` hardcoded

`max_tokens: 2048` is hardcoded with a `// TODO: make configurable`. This limits the maximum completion length. If OmniRoute supports different models with different context windows, this should be configurable per operation type.

**Evidence:** `llm-router.ts:96`

### ⚠️ Finding 2.3: API endpoint format uncertainty

The code calls `/v1/completions` (OpenAI completions API endpoint) but the response parsing handles both formats:
```typescript
const content = response.choices?.[0]?.text ?? response.choices?.[0]?.message?.content ?? '';
```
- `choices[0].text` — completions API format
- `choices[0].message.content` — chat completions API format (`/v1/chat/completions`)

**Runtime verification:** Both formats are supported. When using `/v1/completions`, `choices[0].text` contains the response. When using `/v1/chat/completions` with `messages` field, `choices[0].message.content` contains the response.

### ⚠️ Finding 2.4: No request validation

The `callOmniRoute()` function does not validate request structure before sending. Malformed payloads (e.g., empty model string, missing prompts) are sent to OmniRoute, which may return confusing errors.

---

## Phase 3 — Runtime Verification (LIVE)

**Test environment:** OmniRoute v3.8.42 at `http://localhost:20128` — **no authentication required** on localhost. 21 LLM models, 17 embedding models available.

### 🔴 FINDING 3.1: LLMRouter Will Fail on All LLM Calls (CRITICAL)

**Severity:** CRITICAL — every LLM call through `LLMRouter.execute()` will fail

**Root cause:** The `callOmniRoute()` method sends requests to `/v1/completions` with **no `stream: false` parameter**. OmniRoute defaults to SSE streaming (`text/event-stream`) for all completion endpoints. The response is:
```
data: {"id":"...","object":"text_completion","choices":[{"text":"Hello","index":0}]}
data: {"id":"...","object":"text_completion","choices":[{"text":"!","index":0}]}
data: [DONE]
```

The LLMRouter then calls `return await response.json()` (line 69) on this SSE stream, which throws:
```
JSON.parse FAILED: Unexpected token 'd', "data: {"id"... is not valid JSON
```

**Every LLM call fails with a JSON parse error.** This affects all 8 caller sites through LLMRouter.

**Evidence:**
- `llm-router.ts:69`: `return await response.json();` — called on SSE stream
- `llm-router.ts:93-101`: No `stream: false` in the request payload
- Runtime: `/v1/completions` returns `Content-Type: text/event-stream` when `stream` is not `false`
- Runtime: `response.json()` cannot parse SSE chunks (tested with Deno/Node)

**Impact:**
- `query-parser`: Intent classification fails → full-text only, no LLM-based parsing
- `llm-worker` memory extraction: LLM call fails → job retries → dead-letters → no memories extracted
- `llm-worker` briefing: Briefing draft/verify fails → no briefings generated
- `llm-worker` graph construction: Entity extraction fails → graph never populated
- `retrieve-context` embedding call: Uses `/v1/embeddings`, which is NOT affected (uses JSON, not SSE)

**Fix:** Add `stream: false` to all completion requests in `callOmniRoute()`, OR explicitly set `"stream": false` in the LLMRouter payload.

### ✅ Finding 3.2: Chat completions work correctly with `stream: false`

When `stream: false` IS set, both `/v1/chat/completions` and `/v1/completions` return valid JSON:

```
choices[0].message.content = "Hello!"  (chat format)
choices[0].text = "Hello!"             (completions format)
```

Latency: 1.2-2s per request (auto/best-fast → Groq → Llama 4 Scout)

### ✅ Finding 3.3: JSON response_format supported

`response_format: { type: 'json_object' }` is supported by Groq with Llama 4 Scout. Returns valid JSON in the response.

### ✅ Finding 3.4: Intent classification works

OmniRoute correctly returns meaningful classifications for natural language queries. The `capability` field (reasoning/summarization/extraction) modifies provider/model selection.

### ⚠️ Finding 3.5: `capability` field changes provider routing

Without `capability`: routes to Groq → Llama 4 Scout
With `capability: "reasoning"`: routes to OC → big-pickle (different provider/model)

This means the `capability` field IS respected by OmniRoute for model selection.

### ✅ Finding 3.6: GPU-powered models available

`deepseek-v4-flash` and `big-pickle` are OC-hosted (likely on-premise GPU). Sub-millisecond per-token latency observed (4ms for 10 tokens).

---

## Phase 4 — Provider Routing (LIVE)

### ✅ Architecture: Correct delegation

Cyrus does NOT perform provider routing. It sends a `capability` field (values: `reasoning`, `verification`, `summarization`, `information_extraction`) and lets OmniRoute select the provider. This is the correct architecture.

**Runtime evidence:**

| Model Requested | Provider Selected | Actual Model |
|----------------|-------------------|--------------|
| `auto/best-fast` | Groq | Llama 4 Scout 17B |
| `auto/best-reasoning` | Groq | Llama 4 Scout 17B |
| `auto/best-coding` | Groq | Llama 4 Scout 17B |
| `auto/best-chat` | Groq | Llama 4 Scout 17B |
| `auto/best-vision` | Groq | Llama 4 Scout 17B |
| `auto/best-fast` + `capability: reasoning` | OC | big-pickle (or deepseek-v4-flash) |

**Note:** All `auto/*` models currently route to Groq → Llama 4 Scout in this local instance. The OC provider is selected when `capability` is set.

### ⚠️ Finding 4.1: No client-side fallback

If OmniRoute is unreachable or returns an error, the `LLMRouter.execute()` method throws. There is no fallback to a secondary gateway or direct provider call. The caller must handle the error. For `llm-worker`, this means the job retries up to `max_attempts`, then dead-letters. For `retrieve-context`, the query fails entirely.

---

## Phase 5 — Concurrency Stress Test (LIVE)

### 🔴 FINDING 5.1: System collapses at ≥50 concurrent connections

**Severity:** HIGH — real-world usage with burst traffic will experience massive failures

Test results (15-second sustained load, `auto/best-fast` model):

| Concurrency | Total Requests | Success | Failure | Success Rate | Throughput | p50 | p95 | p99 |
|------------|---------------|---------|---------|-------------|-----------|-----|-----|-----|
| 10 | 36 | 36 | 0 | **100.0%** | 1.1 req/s | 3581ms | 26261ms | 27732ms |
| 50 | 88 | 36 | 52 | **40.9%** | 2.6 req/s | 15858ms | 25702ms | 26632ms |
| 100 | 108 | 20 | 88 | **18.5%** | 3.6 req/s | 30010ms | 30016ms | 30016ms |

**Failure analysis:**
- At concurrency=50: 52/88 failures = "Maximum combo retry limit reached" (OmniRoute's internal routing exhausts all provider retries)
- At concurrency=100: 71/108 timeouts (30s), 17/108 combo retry limit

**Root cause:** The local OmniRoute instance has limited provider capacity. At high concurrency, Groq rate-limits requests. OmniRoute's combo routing retries all providers in priority order, but with sustained load, all providers fail → retry limit exhausted → requests fail.

**Impact:** With even moderate burst traffic (50+ users querying simultaneously), 59% of LLM calls will fail. This is NOT graceful degradation — it's a hard collapse.

### ⚠️ Finding 5.2: Low overall throughput

Even at ideal concurrency (10), throughput is only 1.1 req/s. With average latency of 1.5s per request, theoretical max with 10 workers is 6.7 req/s. Achieving only 1.1 req/s suggests OmniRoute is serializing or connection-pooling requests.

---

## Phase 6 — Failure Testing (LIVE)

### 🔴 FINDING 6.1: Graph Construction Regex Bug (FIXED)

**Severity:** HIGH — every graph construction job was silently failing
**Status:** FIXED during this audit

**Root cause:** Double-escaped backslash in JSON extraction regex:
```typescript
// Before (BUG):
const match = jsonStr.match(/\\{.*\\}/s);   // matches \{...\} — WRONG
// After (FIX):
const match = jsonStr.match(/\{.*\}/s);     // matches {...} — CORRECT
```

**Impact:** Every graph construction job would fail to parse the LLM's JSON response, log `"graph_extraction_json_parse_failed"`, and return `{ success: false, reason: "parse_failed" }`. This means **no graph edges or nodes were ever created from memory content**. The graph was being built with correct schema and RPC but zero data from LLM extraction.

**Reproduction:**
1. Any memory is extracted and approved
2. A `graph_construction` job is enqueued
3. The LLM returns valid JSON like `{"nodes":[...],"edges":[...]}`
4. The regex `/\\{.*\\}/s` fails to match `{...}` (it expects `\{...\}`)
5. `JSON.parse(jsonStr)` errors on the raw string
6. Job returns `{"success": false, "reason": "parse_failed"}`
7. All downstream graph operations (node creation, edge creation, graph_build_audit) are skipped

**Evidence:**
- Line 560: only occurrence of the buggy pattern (6 other `match(/\{.*\}/s)` calls in the same file are correct)
- All other JSON extraction regexes in the codebase use single-escaped braces

### ✅ Finding 6.2: Forced timeout works

Setting an AbortController with 1ms timeout correctly aborts the request. LLMRouter catches this and throws `TIMEOUT`. ✅

### ⚠️ Finding 6.3: Missing messages hangs for full timeout

Sending a completion request without the `messages` field causes OmniRoute to hang for 30 seconds (the full timeout) before returning. No request validation is performed upfront.

### ✅ Finding 6.4: Invalid model returns 404

Requesting a non-existent model (`does/not/exist`) returns HTTP 404 with an error message. OmniRoute correctly rejects invalid models.

### ✅ Finding 6.5: Graceful degradation paths (code review)

The following failure modes are handled correctly in code:

| Failure | Handling | Evidence |
|---------|----------|----------|
| Embedding failure | FTS-only fallback with zero vector | `retrieve-context/index.ts:145-148` |
| JSON parse failure (extraction) | Falls back to rule-based extraction | `llm-worker/index.ts:195-199` |
| JSON parse failure (graph) | Returns `parse_failed` (now fixed) | `llm-worker/index.ts:563-565` |
| Embedding failure (dedup) | Skips dedup search | `llm-worker/index.ts:384-386` |
| Rate limit (429) | Rethrows as `RATE_LIMIT` | `llm-router.ts:61-62` |
| Timeout | `AbortError` → rethrows as `TIMEOUT` | `llm-router.ts:72-74` |

---

## Phase 7 — Load Stability

### 🔴 FINDING 7.1: Cannot sustain 50+ concurrent connections (see Phase 5)

The system fails at 50+ concurrent connections due to provider rate limiting. Sustained load at this level will result in ~60% failure rate. At 100+ connections, ~80% failure rate.

---

## Phase 8 — Response Quality

### ✅ Finding 8.1: Response quality appears correct

Test prompts returned correct, concise answers. Intent classification correctly identified deadlines as "deadline" intent. Entity extraction returned valid JSON structures.

Note: Formal quality metrics (response accuracy, hallucination rate) require a labeled evaluation dataset that is outside the scope of this audit.

---

## Phase 9 — Embeddings (LIVE)

### ⚠️ Finding 9.1: Correct structure

```typescript
async generateEmbedding(text: string): Promise<number[]> {
  const response = await this.callOmniRoute('/v1/embeddings', {
    model: Deno.env.get('OMNIROUTE_EMBEDDING_MODEL') || '',
    input: [text],
    encoding_format: 'float',
    dimensions: 768 // Ensure we get 768 dimensions for compatibility
  });
}
```

### 🔴 FINDING 9.2: Hardcoded dimension = 768 is WRONG for all working models

Line 161 sends `dimensions: 768` and line 165 validates `embedding.length === 768`.

**Runtime evidence:**

| Model | Dimensions Requested | Dimensions Returned | Status |
|-------|---------------------|--------------------|--------|
| NVIDIA nv-embedqa-e5-v5 | 768 | 1024 | **FAIL** — model doesn't support `dimensions` param |
| Mistral mistral-embed | 768 | 1024 | **FAIL** — model doesn't support `dimensions` param |
| OpenAI text-embedding-3-small | 768 | — | Quota exhausted (429) |

**Impact:** Even if an embedding model is configured in `OMNIROUTE_EMBEDDING_MODEL`, the LLMRouter will reject it because:
1. Models that DON'T support `dimensions` (NVIDIA, Mistral) return 400 error
2. Models that DO support `dimensions` (OpenAI) have no remaining quota

The `embedding.length === 768` validation at line 165 means **every embedding request fails** with any currently-working provider. This makes the embedding fallback (FTS-only with zero vector) the ONLY path that succeeds.

### ⚠️ Finding 9.3: Single embedding per call

Each embedding request sends a single text. There's no batching. This is correct for the usage patterns but means embedding throughput is limited by OmniRoute's per-request latency.

---

## Phase 10 — Streaming

### 🔴 FINDING 10.1: Streaming default breaks LLMRouter (same as Finding 3.1)

**Severity:** CRITICAL — OmniRoute defaults to SSE streaming, LLMRouter expects JSON

### ✅ Finding 10.2: Cyrus does not use streaming

Cyrus does not use streaming for any LLM call. All calls are synchronous request-response. No backpressure, cancellation, or partial response handling is needed.

---

## Phase 11 — Cost Validation

### ⚠️ Finding 11.1: Placeholder pricing

`pricing.ts` contains placeholder values:
```typescript
'omniroute': { inputPer1k: 0.0001, outputPer1k: 0.0002 }
```

**Runtime evidence:** All OmniRoute responses include:
```
x-omniroute-response-cost=0.0000000000
```

The actual cost is returned by OmniRoute in headers, but the LLMRouter and pricing.ts do not use it. Cost estimates flowing into `metrics_snapshot` and `cost_events` are inaccurate until real pricing is configured.

### ⚠️ Finding 11.2: Token estimation fallback is invisible

When OmniRoute doesn't return `usage` in the response, tokens are estimated as `chars / 4` with `estimated: true` flag. This flag is stored in `LLMResponse.estimated` but never surfaced to dashboards, alerts, or the `cost_events` table. Operators have no way to know which cost records are estimated vs actual.

---

## Phase 12 — Security

### ✅ No API key leakage

The API key is read from `Deno.env.get('OMNIROUTE_API_KEY')` and used only in the Authorization header. It is never logged, returned in responses, or stored in the database.

### ⚠️ Finding 12.1: No authentication on local OmniRoute

The local OmniRoute instance accepts requests **without any API key**. The dashboard at `http://localhost:20128` is publicly accessible. This is expected for local development but must not be exposed to the network.

### ⚠️ Finding 12.2: Error messages may contain useful information

Error messages like `'OmniRoute configuration missing'`, `'Invalid embedding response from OmniRoute'`, and `'All embedding providers failed via OmniRoute'` are thrown and may appear in:
- Edge function console.log/console.error
- Job `last_error` fields in `llm_jobs`
- 500 error responses (if not caught by outer try/catch)

None contain secrets, but they do leak internal architecture details.

### ✅ No secrets in responses

The `LLMResponse` type only exposes: `content`, `provider`, `model`, `latencyMs`, `inputTokens`, `outputTokens`, `totalTokens`, `costEstimate`, `estimated`.

---

## Phase 13 — Performance (LIVE)

### ⚠️ Finding 13.1: Latency distribution

All request types combined (253 requests):

| Metric | Value |
|--------|-------|
| p50 | 19255ms |
| p90 | 30014ms |
| p95 | 30015ms |
| p99 | 30016ms |
| min | 2ms |
| max | 30050ms |

**Note:** The high latency includes stress test timeouts. Individual request latency at low concurrency is 1.2-6s.

**Individual operation latencies:**

| Operation | Latency | Provider |
|-----------|---------|----------|
| Text completion | 1.2s | Groq |
| Chat completion | 1.8s | Groq |
| Reasoning completion | 6.2s | Groq |
| Coding/JSON | 5.6s | Groq |
| Intent classification | 1.5s | Groq |
| NVIDIA embedding | 399ms | NVIDIA |
| Mistral embedding | 572ms | Mistral |

### 🔴 FINDING 13.2: Throughput collapse at high concurrency

Maximum observed throughput: 3.6 req/s (at concurrency=100, 81% failure rate)
Effective throughput (success only): 0.7 req/s at concurrency=100

---

## Phase 14 — Code Quality

### ✅ Finding 14.1: Minimal technical debt

- 1 TODO in production code: `llm-router.ts:96` — `max_tokens` hardcoded at 2048
- No FIXME, HACK, or deprecated markers
- No dead code paths
- No legacy provider references

### ✅ Finding 14.2: Clean migration from old architecture

The `provider_health` table was dropped in migration `20260627000239_drop_provider_health.sql`. All `provider_health` references removed from code. The `pricing.ts` file is the only remaining structure that references provider-specific pricing, but it contains only the single `omniroute` entry.

### ⚠️ Finding 14.3: Late import in llm-router.ts

`import { createClient }` appears at line 178 — after the class definition. Valid in Deno (imports are hoisted) but unconventional and could confuse tooling.

---

## Risk Assessment

| Risk | Severity | Likelihood | Impact | Status |
|------|----------|------------|--------|--------|
| **LLMRouter JSON parse failure on SSE** | **CRITICAL** | Certain | Every LLM call fails: no intent classification, no memory extraction, no briefings | Open |
| **Embedding dimension mismatch (768 vs 1024)** | **HIGH** | Certain | Every embedding request fails: only degraded FTS path works | Open |
| Graph construction never writes data | **HIGH** | Certain | No graph edges created from memory extraction | **FIXED** |
| Concurrency collapse at 50+ | **HIGH** | High | 59-81% failure rate under burst traffic | Open |
| No LLM router test coverage | **MEDIUM** | High | Regression undetected | Open |
| Empty model defaults (completions) | **MEDIUM** | Medium | 400 error if OMNIROUTE_DEFAULT_MODEL not set | Open |
| Empty model defaults (embeddings) | **MEDIUM** | Medium | 400 error if OMNIROUTE_EMBEDDING_MODEL not set | Open |
| Placeholder pricing | **LOW** | Certain | Cost dashboards inaccurate | Open |
| Hardcoded max_tokens | **LOW** | Low | Truncated long completions | Open |
| No client-side OmniRoute fallback | **MEDIUM** | Low | Complete service outage if OmniRoute is down | Open |
| No auth on local OmniRoute | **MEDIUM** | Low | Security risk if port exposed | Open |

---

## Production Readiness Score: **32 / 100** (updated with runtime evidence)

| Phase | Max | Score | Notes |
|-------|-----|-------|-------|
| 1. Architecture | 15 | 15 | Clean, verified |
| 2. Configuration | 10 | 4 | Empty defaults, hardcoded param, no stream:false |
| 3. Runtime | 15 | 0 | SSE default breaks ALL LLM calls (CRITICAL) |
| 4. Routing | 10 | 5 | Architecture correct, single provider (Groq) only |
| 5. Concurrency | 10 | 2 | Collapse at 50+ connections, 3.6 req/s max |
| 6. Failure | 10 | 5 | Graph bug fixed, other paths OK |
| 7. Stability | 5 | 0 | Cannot sustain 50+ connections |
| 8. Quality | 5 | 3 | Responses appear correct |
| 9. Embeddings | 5 | 0 | 768-dim check rejects all working providers |
| 10. Streaming | 5 | 0 | Default SSE breaks synchronous parsing |
| 11. Cost | 5 | 1 | Placeholder pricing, OmniRoute returns cost but unused |
| 12. Security | 5 | 4 | Key not logged, local instance unauthenticated |
| 13. Performance | 5 | 0 | p95 > 30s, throughput < 4 req/s |
| 14. Code quality | 5 | 3 | 1 TODO, clean migration, minor import issue |
| **Total** | **100** | **32** | |

### Score breakdown

- **-30** Two critical issues: SSE streaming breaks ALL LLM calls, and embedding dimension mismatch breaks ALL embedding calls
- **-15** Configuration gaps (empty model defaults, stream:false missing)
- **-15** Stress test collapse (high concurrency failure)
- **-8** Performance (p95 > 30s, throughput < 4 req/s)
- Remaining **+32** for clean architecture, security posture, and the one fixed defect

### Critical remediation path to 70+

1. **IMMEDIATE - Fix LLMRouter:** Add `stream: false` to all completion requests in `callOmniRoute()`. This is a one-line fix that unblocks ALL LLM operations.
2. **HIGH - Fix embedding dimension:** Either remove the `dimensions: 768` parameter (let provider decide), or make it configurable and match the model. Update the validation to accept 1024 as well.
3. **HIGH - Set model defaults:** Configure `OMNIROUTE_DEFAULT_MODEL` and `OMNIROUTE_EMBEDDING_MODEL` environment variables so the router doesn't send empty strings.
4. **MEDIUM - Stress test production:** Run the same concurrency tests against the production OmniRoute instance. The local instance may have different provider capacity.
5. **MEDIUM - Add router tests:** Mock OmniRoute responses and test timeout/error/response parsing paths.
6. **LOW - Use OmniRoute cost headers:** The `x-omniroute-response-cost` header contains actual cost data. Use it instead of the pricing.ts placeholder.
7. **LOW - Configurable max_tokens:** Make `max_tokens` configurable per operation type.
