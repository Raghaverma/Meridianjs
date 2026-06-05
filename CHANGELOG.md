# Changelog

All notable changes to Meridian are documented here.

---

## [0.2.5] — Adoption Sprint

### Added

**Service Routing — Weighted & Geo**
- `strategy: "weighted"` — probabilistic load distribution across providers using a `weights` map (e.g. `{ stripe: 70, razorpay: 30 }`)
- `strategy: "geo"` — region-aware routing via `MERIDIAN_REGION` env var or `defaultRegion`; `regions` maps region names to ordered provider lists
- Both strategies select a primary provider via `selectIndex()` and failover through remaining providers on retryable errors

**Policy Engine — Three New Built-ins**
- `redact(fields, providers?)` — redacts dot-notation field paths (e.g. `"user.ssn"`) from the request body before it reaches the provider; does not block the request
- `requireFields(fields, providers?)` — blocks requests missing required body fields; returns `MeridianError` with `category: "validation"`
- `denyCountries(codes, field?)` — blocks requests where `body.country`, `body.country_code`, or `body.countryCode` matches a denied ISO 3166-1 alpha-2 code

**Schema Monitor — Three New Methods**
- `meridian.schema.diff(provider, endpoint, data)` — returns drift between current data and stored schema baseline
- `meridian.schema.report(provider)` — returns structured `SchemaReport` with all snapshotted endpoints, field counts, and schemas
- `meridian.schema.alert(provider, endpoint, data, callback)` — runs drift check and invokes callback with drifts if any are detected; returns the drifts array

**Documentation**
- `docs/payments/` — Stripe/Razorpay/Cashfree unified interface, failover, analytics
- `docs/llms/` — OpenAI→Anthropic→Gemini failover, production chat endpoints
- `docs/communications/` — Twilio→MSG91 SMS fallback, email fallback patterns
- `docs/failover/` — all 7 routing strategies with runnable examples
- `docs/policies/` — all policy built-ins with fintech compliance example
- `docs/schema-drift/` — full snapshot→diff→report→alert workflow
- `docs/transactions/` — saga pattern with multi-step rollback example

**Cost Intelligence**
- `MeridianConfig.providerCosts` — declare per-request cost for each provider (e.g. `{ openai: 0.03, anthropic: 0.01 }`)
- `meridian.cost(currency?)` — returns `CostReport` with per-provider request counts, cost-per-request, estimated spend, and a total; resets with `analytics.reset()`
- `CostReport`, `CostEntry` exported from `meridianjs`

**Examples**
- `examples/nextjs-openai-failover/` — Next.js 14 App Router LLM endpoint with failover
- `examples/express-stripe/` — Express server with pagination, idempotency, health endpoint
- `examples/nestjs-payments/` — NestJS module with DI, weighted routing, saga transaction
- `examples/fastify-webhooks/` — Fastify webhook verification with raw body parsing
- `examples/multi-provider-llm/` — Node.js script demonstrating failover, cheapest routing, drift detection, analytics

---

## [0.2.4] — Operational Intelligence

This release transforms Meridian from an API normalisation SDK into an operational layer for third-party integrations. Every feature below works with zero configuration beyond what you already have.

### Added

**Service Abstraction & Failover**
- `meridian.service("name")` — logical service client that routes across multiple providers
- `MeridianConfig.services` — configure provider groups with a routing strategy
- Routing strategies: `"failover"`, `"round-robin"`, `"lowest-latency"`, `"cheapest"`, `"highest-success-rate"`
- `"lowest-latency"` self-calibrates via EWMA over `meta.trace.latency`
- `"highest-success-rate"` routes dynamically using live analytics data
- `"cheapest"` accepts a `costs` map and fails over in ascending cost order

**Request Trace**
- `result.meta.trace` — always present: `retries`, `latency`, `circuitBreaker`, `rateLimitRemaining`
- `ResponseContext.trace` — trace data now visible to all observability adapters

**Analytics & Health**
- `meridian.analytics()` — per-provider: `requests`, `errors`, `errorRate`, `successRate`, `avgLatency`, `p95Latency`
- `meridian.health()` — per-provider status (`healthy`/`degraded`/`down`) combining analytics + circuit breaker
- `AnalyticsCollector` always active, zero configuration required

**Debug Recording & Replay**
- `meridian.debug.enable()` / `.disable()` / `.clear()`
- `meridian.debug.recordings()` — full log with trace data and original request options
- `meridian.replay(requestId)` — re-execute any recorded request with identical options

**Policy Engine**
- `MeridianConfig.policies` — evaluate before every request, block or allow
- Built-ins: `blockPII()`, `allowedProviders()`, `blockedProviders()`, `readOnly()`, `customPolicy()`
- PII detection covers: credit cards, SSNs, emails, phone numbers, Aadhaar, PAN
- Blocked requests throw `MeridianError` with `category: "validation"` — no network round-trip wasted

**Multi-Provider Transactions**
- `meridian.transaction(steps)` — saga pattern across multiple providers
- Per-step `rollback` function; executed in reverse order on failure
- `TransactionError` carries `failed`, `succeeded`, `rolledBack`, `rollbackErrors`, `results`

**Schema Drift Detection (enhanced)**
- `meridian.schema.snapshot(provider, endpoint, data)` — baseline any live response
- `meridian.schema.check(provider, endpoint, data)` — detect field removals, type changes, required changes
- `DriftDetector` now recurses into nested object and array schemas

**Provider Capability Registry**
- `meridian.providers()` — all configured providers with capability arrays
- `meridian.findProviders({ capability })` — filter by capability string
- 39 providers mapped: chat, embeddings, streaming, payments, kyc, upi, shipping, maps, and more

**Adapter Generator**
- `npx meridian generate --provider <name> [--openapi spec.json]`
- Parses OpenAPI 3.x JSON: extracts base URL, auth type, endpoint list
- Generates `adapter.ts`, `adapter.test.ts` (8 passing tests out of the box), `pagination.ts`, `index.ts`

### Changed

- `DriftDetector.detect()` now recursively compares nested schemas (previously top-level only)
- `ResponseContext` gains optional `trace?: RequestTrace` for observability adapter use

---

## [0.2.3] — SDK Prototype

- 39 provider adapters with unified contract
- Normalized responses, errors, pagination, rate limits
- Circuit breaker, retry, rate limiting
- Webhook verification
- Contract testing suite (19 invariants per adapter)
- Streaming (SSE) for OpenAI, Anthropic, Gemini, Mistral, Cohere
- Batch requests with concurrency control
- India compliance mode (DPDPA PII redaction)
- Proxy server (`boundary-proxy`)
- Observability adapters: Console, NoOp, OpenTelemetry, Prometheus
