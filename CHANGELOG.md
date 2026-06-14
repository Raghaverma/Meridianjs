# Changelog

All notable changes to Meridian are documented here.

---

## [Unreleased]

---

## [0.3.0] — 2026-06-14

### Added

- **Docker Boundary Proxy** — `Dockerfile`, `docker-compose.yml`, and `.env.example` ship in the repo root. `docker compose up -d` starts the gRPC engine on `127.0.0.1:4242` with a built-in healthcheck — no Node or npm required on the host. See [docs/polyglot.md](docs/polyglot.md).
- **Go reference client** ([`clients/go`](clients/go)) — a complete, end-to-end-tested binding with pre-generated protobuf stubs, a typed `Client` struct, and a conformance suite that boots the proxy in Docker and asserts auth enforcement, SSRF guards, and error normalization. `go get github.com/Raghaverma/meridianjs/clients/go/meridian`.
- **Rust client** ([`clients/rust`](clients/rust)) — async `tonic`-based binding; generates stubs from `proto/meridian.proto` at build time via `build.rs`. Normalized errors and the same call shape as the Go client.
- **`StreamCall` gRPC RPC** — streams SSE token deltas (Anthropic, OpenAI, Gemini, Cohere, Mistral, …) to any gRPC client language-by-language, with no JS runtime required. Emits one `StreamChunk` per upstream delta; the terminal chunk carries `done: true`. See `proto/meridian.proto`.
- **Proto CI job** — `buf lint`, breaking-change detection against `origin/main` (on PRs), Go stub freshness check (`clients/go/genproto` must match `make generate`), Go build + vet, and the full conformance suite run on every push. Uses the same `bufbuild/buf:1.70.0` image as the `Makefile` so CI and local never drift.
- **`meridian add <provider>`** — one-command provider generation: resolves the OpenAPI spec (curated registry: slack, github, stripe, twilio, box, sendgrid — or `--openapi <url|path>`), then generates the adapter, unit tests, **contract tests** (the same 19-invariant battery every built-in adapter passes — green out of the box), a pagination strategy inferred from the spec's query parameters (cursor/page/offset style + exact param name), retry classification grounded in the spec's documented status codes, and a `GENERATED.md` completeness report scoring what was inferred vs assumed (every heuristic carries a `TODO(meridian-generator)` marker).
- **OpenTelemetry auto-instrumentation** — `telemetry: { provider: "opentelemetry" }` (or `meridian.instrumentOpenTelemetry()`) binds spans/metrics/errors to `@opentelemetry/api` (new optional peer dependency) with one line; exporter recipes for Datadog, Grafana, Honeycomb, and New Relic in [docs/opentelemetry.md](docs/opentelemetry.md).
- **Reliability replay** — `meridian.startRecording(name)` / `stopRecording()` capture the pipeline's behavior timeline (outcomes, retries, breaker states, latencies — never payloads) to `.meridian/recordings/<name>.json`; `meridian replay <name>` re-renders the outage locally with derived failovers, breaker transitions, and latency stats; `meridian.replaySession()` re-emits the timeline through observability adapters. See [docs/reliability-replay.md](docs/reliability-replay.md).
- **Adaptive routing** — `strategy: "adaptive"` for services scores providers on observed success rate + latency + circuit-breaker state with explicit `adaptiveWeights`; ranking is deterministic (ties explore unmeasured providers once, then settle to config order).
- **`meridian migrate <provider>`** — scans a codebase for direct SDK imports, client constructions, mapped method calls, and hand-rolled HTTP calls (openai, anthropic, stripe, github, twilio, sendgrid, razorpay), reporting what maps cleanly to Meridian and what needs manual attention, plus a suggested provider config. Read-only — no rewriting.
- **Local contract registry** — `meridian.registry.snapshot/check/report/history` and the `meridian registry` CLI: versioned response-schema snapshots with append-only drift history under `.meridian/registry/`, designed to be committed to git; `registry check` exits non-zero on breaking drift for CI gating. See [docs/registry.md](docs/registry.md).
- **Unified CLI** — the `meridian` binary now dispatches `add`, `generate`, `migrate`, `replay`, and `registry` subcommands.

### Fixed

- **Anthropic and OpenAI auth in the Boundary Proxy** — `shared.ts` was placing the API key in `auth.apiKey`, but those adapters read `auth.token`; the mismatch silently broke all proxied calls to both providers (including `StreamCall`). The key is now placed in `auth.token` as the adapters expect.
- **HTTP errors were never retried.** `executeHttpRequest` throws raw `{status, headers, body}` objects, but the retry strategy only retried errors already carrying `retryable: true` — so a real 429/503 from a provider failed immediately regardless of retry config (only timeouts and pre-classified mock errors ever retried). The pipeline now classifies raw HTTP failures through the adapter's `parseError` at the retry decision point, while propagating the original error unchanged.
- **OpenTelemetry metric corruption** — `OpenTelemetryObservability.recordMetric()` funneled every pipeline metric into the `meridian.requests` counter, inflating request counts; named metrics now get their own counters.
- **Flat-config key collision** — top-level `services`, `policies`, `providerCosts`, and the new `telemetry` keys were treated as provider configs when using the flat config style.

---

## [0.2.12]

### Fixed

- **Python client tests** — `clients/python/tests` is now a proper package (`tests/__init__.py`), so `pytest` can resolve `from tests.conftest import ...` in `test_client.py` and `test_grpc.py`.

---

## [0.2.11]

### Added

- **Hunter provider** — full request/response normalization, auth handling, and error mapping, bringing the adapter count to 46 (874 contract tests).
- **Polyglot contract** — the Meridian contract is now defined as a language-neutral gRPC IDL ([`proto/meridian.proto`](proto/meridian.proto)), covering `RequestOptions`, `NormalizedResponse`, `ResponseMeta`, and `MeridianError`.
- **gRPC Boundary Proxy** — `src/proxy/grpc-server.ts` replaces the previous HTTP proxy, serving `meridian.v1.Meridian` (`Call`, `Paginate`, `Health`) backed by the TS engine. `@grpc/grpc-js` and `@grpc/proto-loader` are optional peer dependencies, loaded lazily so the SDK core stays dependency-free.
- **Native Python engine** ([`clients/python`](clients/python)) — a from-scratch Python port of the pipeline (retry, circuit breaking, rate limiting, sanitization, normalization) with reference adapters for GitHub, OpenAI, Anthropic, and Stripe. It runs standalone and speaks the same proto, so it can serve the contract or consume either engine.

### Changed

- **Boundary Proxy** — `npx boundary-proxy` now starts a gRPC server instead of an HTTP server; the previous Node-based HTTP proxy is deprecated in favor of the gRPC bridge.

---

## [0.2.10]

### Fixed

- **Observability** — `error.message` and `error.name` were silently dropped from the `error` object passed to `ObservabilityAdapter.logError()` (Console, OTel, Prometheus adapters). `Error` properties are non-enumerable, so a plain object spread in the pipeline's error handler discarded them, leaving every logged error with `message: undefined`. Both fields are now preserved.

### Added

- `docs/comparisons/` — Meridian vs. Raw SDKs, LangChain, OpenRouter, and API Gateways, plus an overview index
- `docs/what-is-meridian.md` — category-definition doc (reliability layer vs. wrapper / gateway / iPaaS)
- `npm run demo:failover`, `demo:circuit-breaker`, `demo:schema-drift`, `demo:service-routing` — narrative demo scripts showing each failure mode end-to-end

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
