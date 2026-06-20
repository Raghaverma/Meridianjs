<div align="center">

# Meridian

**API Reliability Layer**

Build once. Survive provider failures.

[![npm](https://img.shields.io/npm/v/meridianjs?color=0070f3)](https://www.npmjs.com/package/meridianjs)
[![version](https://img.shields.io/badge/version-0.3.3-blue)](CHANGELOG.md)
[![tests](https://img.shields.io/badge/tests-2094%20passing-brightgreen)](https://vitest.dev)
[![adapters](https://img.shields.io/badge/adapters-47-blueviolet)](#providers)
[![contracts](https://img.shields.io/badge/contract%20tests-1637-brightgreen)](#providers)
[![types](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)

47 providers · 1637 contract tests · 0.11 ms overhead · 27 ms failover recovery.

</div>

```bash
npm install meridianjs
```

> Requires **Node.js ≥ 20**. TypeScript-first, ships its own types, ESM-only.

<div align="center">

<img src="assets/meridian-architecture.svg" alt="Meridian sits between your application and every external API, applying policies, circuit breaking, rate limiting, retries, and normalization before requests reach Stripe, OpenAI, Razorpay, Anthropic, and 41 more providers." width="920">

</div>

One layer between your app and every provider. The same retries, error format, failover, and traces — no matter which API is behind it.

---

## Quick Start

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_KEY } },
    openai: { auth: { apiKey: process.env.OPENAI_KEY } },
  },
});

const { data, meta } = await meridian.provider("stripe")!.get("/v1/customers");

meta.rateLimit.remaining  // always normalized
meta.pagination?.hasNext  // always normalized
meta.trace.latency        // ms, always present
meta.trace.retries        // how many retries
meta.trace.circuitBreaker // CLOSED | OPEN | HALF_OPEN
```

---

## What Meridian Does

| | Without | With |
|---|---|---|
| Errors | Different shape per provider | `MeridianError` — always `category`, `retryable`, `retryAfter` |
| Rate limits | Parse per provider | `meta.rateLimit` — normalized |
| Pagination | cursor / offset / link per provider | `meta.pagination` — normalized |
| Retries | Manual | Exponential backoff, idempotency-safe |
| Circuit breaking | Manual | Automatic, per-provider |
| Provider outage | App breaks | Automatic failover |
| API drift | Silent breakage | `meridian.schema.check()` |

---

## Features

- **[Provider failover](docs/failover/index.md)** — define a service with multiple providers; Meridian routes around outages automatically.
- **[Retries](docs/retries.md)** — exponential backoff with idempotency safety; per-adapter retry classification.
- **[Rate limiting](docs/rate-limits.md)** — token-bucket per provider, adaptive backoff, shared cooldown across replicas via `RedisStateStorage`.
- **[Circuit breaker](docs/circuit-breaker.md)** — per-provider; wraps the retry loop so retries count as one logical failure.
- **[Pagination](docs/pagination.md)** — cursor, offset, and link-header strategies; `meta.pagination` is always normalized.
- **[Observability](docs/opentelemetry.md)** — OpenTelemetry auto-instrumentation with one line; Datadog, Grafana, Honeycomb, New Relic recipes included.
- **[Policy engine](docs/policies/index.md)** — `blockPII`, `redact`, `denyCountries`, `allowedProviders`, `readOnly` run before every request.
- **[Schema drift detection](docs/schema-drift/index.md)** — snapshot and diff API contracts; gate CI on drift.
- **[Contract registry](docs/registry.md)** — versioned snapshots under `.meridian/registry/`, designed to be committed.
- **[Reliability replay](docs/reliability-replay.md)** — record and re-render outage timelines locally.
- **[Transactions](docs/transactions/index.md)** — multi-provider sagas with compensating rollbacks.
- **[India / fintech](docs/fintech.md)** — UPI, Razorpay, Aadhaar/PAN redaction, DPDPA compliance mode, 13 Indian payment adapters.
- **[CLI](docs/quickstart.md#cli)** — `meridian add <provider>` generates adapters from OpenAPI specs.

---

## Polyglot

One engine, any language. Start the proxy — no Node required on the host:

```bash
cp .env.example .env   # set MERIDIAN_PROXY_TOKEN + provider creds
docker compose up -d   # gRPC engine on 127.0.0.1:4242
```

Pre-built clients in [`clients/`](clients/) for **Go**, **Rust**, and **Python** — all backed by the same 47-provider engine over gRPC. See [docs/polyglot.md](docs/polyglot.md) for full usage, `StreamCall` streaming, and generating clients for C++, Java, C#, and more from the proto.

---

## Security

- **SSRF protection** — endpoints validated as relative paths before any request is built; `isSafeEndpoint()` for untrusted input.
- **Credential & PII redaction** — `authorization` / `token` / `cookie` always redacted; opt-in PII coverage including Aadhaar, PAN, VPA in India mode.
- **Webhook verification** — timing-safe HMAC checks; Stripe timestamp freshness enforced.
- **Zero required runtime deps** — no supply-chain risk; gRPC proxy pulls optional peers only.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

---

## Providers

**47 adapters**, each passing 19 contract invariants (1637 contract tests). Verify any one: `npm run test:contracts stripe`.

| Category | Count | Providers |
|---|---|---|
| **Payments** | 13 | Stripe · Razorpay · Cashfree · PayU · Juspay · Braintree · Adyen · Klarna · Mollie · PhonePe · Checkout.com · BillDesk · CCAvenue |
| **AI / LLM** | 5 | OpenAI · Anthropic · Gemini · Cohere · Mistral |
| **Communications** | 7 | Twilio · SendGrid · Mailgun · Vonage · MSG91 · Exotel · Gupshup |
| **KYC / Identity** | 7 | HyperVerge · Digio · Karza · IDfy · Setu · Decentro · Perfios |
| **Tools & Infra** | 7 | GitHub · HubSpot · Supabase · Auth0 · Apollo · Hunter · S3 |
| **Mapping** | 2 | Google Maps · MapMyIndia |
| **Observability** | 2 | Sentry · Datadog |
| **Logistics** | 2 | Shiprocket · Delhivery |
| **Other** | 1 | Cleartax |

India-fintech providers and compliance details: [docs/fintech.md](docs/fintech.md).

---

## Contributing

New adapter: `npx meridian add <name> --openapi ./spec.json` → review `GENERATED.md` → `npm test`.

[Changelog](CHANGELOG.md) · [License: MIT](LICENSE.md) · [npm](https://www.npmjs.com/package/meridianjs)
