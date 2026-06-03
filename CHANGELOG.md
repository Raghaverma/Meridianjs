# Changelog

All notable changes to Meridian are documented here.

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
