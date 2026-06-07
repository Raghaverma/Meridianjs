<div align="center">

# Meridian

**Integration Reliability SDK**

[![npm](https://img.shields.io/npm/v/meridianjs?color=0070f3)](https://www.npmjs.com/package/meridianjs)
[![version](https://img.shields.io/badge/version-0.2.7-blue)](CHANGELOG.md)
[![tests](https://img.shields.io/badge/tests-1858%20passing-brightgreen)](https://vitest.dev)
[![adapters](https://img.shields.io/badge/adapters-45-blueviolet)](#providers)
[![contracts](https://img.shields.io/badge/contract%20tests-855-brightgreen)](#providers)
[![types](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)

45 providers · 855 contract tests · 0.11 ms overhead · 27 ms failover recovery.

</div>

```bash
npm install meridianjs
```

> Requires **Node.js ≥ 18**. TypeScript-first, ships its own types, ESM-only.

---

## Reliability Scorecard

Meridian doesn't claim reliability — it proves it. Every line below is a deterministic assertion against the live pipeline ([`npm run benchmark`](benchmarks/reliability.ts)):

```
✓ 10,000 requests tracked in 1.22s
✓ OpenAI outage recovered via failover in 27ms
✓ Stripe 429 automatically retried
✓ Circuit breaker opened after 5 failures
✓ Schema drift detected before deployment
✓ 45 adapters each pass 19 contract invariants (855 tests total)
```

The runner exits non-zero if any assertion fails — it doubles as a CI gate. Reproduce locally:

```bash
npm run benchmark           # full suite → writes benchmarks/RESULTS.md
npm run benchmark:reliability  # reliability checks only
```

---

## Contents

- [Why Meridian Exists](#why-meridian-exists)
- [Reliability Scorecard](#reliability-scorecard)
- [Benchmarks](#benchmarks)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [What Meridian Does](#what-meridian-does)
- [Provider Failover](#provider-failover)
- [Observability](#observability)
- [Policy Engine](#policy-engine)
- [Transactions](#transactions)
- [Schema Drift Detection](#schema-drift-detection)
- [More Features](#more-features)
- [Providers](#providers)
- [Contributing](#contributing)

---

## Why Meridian Exists

Every integration team rewrites the same things.

Retries. Pagination. Rate limit parsing. Error normalization. Failover logic.

They write it once for Stripe. Then again for Razorpay. Then again for OpenAI. The code is never shared because every provider has a different shape.

Meridian provides a single reliability layer between your application and third-party APIs. Write your integration once. Every provider gets the same retry behavior, the same error format, the same pagination interface, the same circuit breaker, the same trace data.

The two features that make it more than a wrapper:

**Service abstraction** — your application calls `service("payments")`, not `provider("stripe")`. Meridian decides which provider handles the request. Your application is never coupled to a specific vendor.

**Schema drift detection** — providers silently change their API responses. Meridian detects the change before it reaches production.

---

## Benchmarks

Same failures. Different outcomes. Measured in-process against deterministic `MockAdapter`s — no network, fully reproducible. "Raw SDK" = a single provider, no retry, no failover, no circuit breaker.

| Scenario | Raw SDK | Meridian |
|---|---|---|
| OpenAI outage | ❌ Fails every call | ✅ Fails over to Anthropic in 27 ms |
| Stripe 429 | ❌ Gives up | ✅ Retries to success |
| 5 consecutive failures | ❌ Every call hits dead upstream | ✅ Circuit opens; fail-fast in < 1 ms |
| `customer_name` removed silently | ❌ Silent breakage | ✅ `FIELD_REMOVED` ERROR detected |
| Added overhead per call | — | **+0.11 ms** |

Full breakdown: `npm run benchmark` → [`benchmarks/RESULTS.md`](benchmarks/RESULTS.md).

---

## Architecture

```mermaid
graph TD
    App[Your Application] --> M[Meridian]
    M --> P[Policy Engine]
    P --> CB[Circuit Breaker]
    CB --> RL[Rate Limiter]
    RL --> RT[Retry]
    RT --> S[Stripe]
    RT --> O[OpenAI]
    RT --> R[Razorpay]
    RT --> More[···41 more]
```

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

## Provider Failover

Your app calls `"llm"`. It never touches `"openai"` or `"anthropic"` directly.

```typescript
const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:    { auth: { apiKey: "..." } },
    anthropic: { auth: { apiKey: "..." } },
    gemini:    { auth: { apiKey: "..." } },
  },
  services: {
    llm: { providers: ["openai", "anthropic", "gemini"], strategy: "failover" },
  },
});

await meridian.service("llm")!.post("/v1/chat/completions", { body: { ... } });
```

```mermaid
sequenceDiagram
    App->>Meridian: service("llm").post(...)
    Meridian->>OpenAI: attempt
    OpenAI-->>Meridian: 503 outage
    Meridian->>Anthropic: failover
    Anthropic-->>Meridian: 200 OK
    Meridian-->>App: result (meta.provider = "anthropic")
```

**Routing strategies:** `failover` · `round-robin` · `lowest-latency` · `cheapest` · `highest-success-rate` · `weighted` · `geo`

```typescript
// weighted: 70% Stripe, 30% Razorpay
payments: { providers: ["stripe", "razorpay"], strategy: "weighted", weights: { stripe: 70, razorpay: 30 } }

// geo: route by region (MERIDIAN_REGION env var)
payments: { providers: ["razorpay", "stripe"], strategy: "geo", regions: { "ap-south-1": ["razorpay"], "us-east-1": ["stripe"] } }
```

---

## Observability

Every response includes a trace. No configuration needed.

```typescript
result.meta.trace
// { retries: 2, latency: 341, circuitBreaker: "CLOSED", rateLimitRemaining: 91 }

meridian.analytics()
// { stripe: { requests: 12431, errorRate: "0.3%", avgLatency: 240, p95Latency: 480 } }

meridian.health()
// { stripe: { status: "healthy", successRate: "99.7%", circuitBreaker: "CLOSED" } }

meridian.cost()
// { providers: { openai: { requests: 1243, costPerRequest: 0.03, estimatedSpend: 37.29 } },
//   total: { requests: 1243, estimatedSpend: 37.29 }, since: "2026-06-05T...", currency: "USD" }
```

---

## Policy Engine

Runs before every request. No network round-trip on block.

```typescript
import { blockPII, redact, requireFields, denyCountries, allowedProviders, readOnly, customPolicy } from "meridianjs";

policies: [
  blockPII(["openai"]),                    // blocks credit cards, SSNs, emails, Aadhaar, PAN
  redact(["user.ssn", "card.number"]),     // redacts fields in-place — request still goes through
  requireFields(["tenantId"]),             // blocks if required fields missing
  denyCountries(["KP", "IR"]),            // blocks by ISO 3166-1 country code
  allowedProviders(["openai", "stripe"]),  // provider whitelist
  readOnly(["github"]),                    // no writes
  customPolicy("require-tenant", (ctx) =>
    "tenantId" in (ctx.body as object)
      ? { allow: true }
      : { allow: false, reason: "tenantId required" }
  ),
]
```

---

## Transactions

Saga pattern. Failed steps trigger compensating rollbacks in reverse order.

```typescript
await meridian.transaction([
  {
    name: "charge",
    execute:  () => stripe.post("/v1/charges", { body: { amount: 2000 } }),
    rollback: (r) => stripe.post(`/v1/charges/${r.data.id}/refund`),
  },
  {
    name: "email",
    execute: () => sendgrid.post("/v3/mail/send", { body: { ... } }),
  },
]);
```

```mermaid
flowchart LR
    A[charge ✓] --> B[email ✗]
    B -- failure --> C[rollback: charge]
    C --> D[TransactionError]
```

---

## Schema Drift Detection

Snapshot a response. Check later. Get alerted when the provider changes their API silently.

```typescript
await meridian.schema.snapshot("stripe", "/v1/customers", response.data);

const drifts = await meridian.schema.check("stripe", "/v1/customers", laterResponse.data);
// [{ type: "FIELD_REMOVED", field: "customer_name", severity: "ERROR" }]

await meridian.schema.alert("stripe", "/v1/customers", newData, (drifts, provider, endpoint) => {
  pagerDuty.trigger(`Schema drift on ${provider}${endpoint}`);
});

const report = await meridian.schema.report("stripe");
// { provider: "stripe", endpoints: [{ endpoint: "/v1/customers", fieldCount: 12, version: "..." }] }
```

---

## More Features

```typescript
// Debug & replay
meridian.debug.enable();
await meridian.replay(requestId); // re-runs with exact original options

// Capability registry
meridian.findProviders({ capability: "streaming" });
// [{ name: "openai" }, { name: "anthropic" }, { name: "gemini" }, ...]

// Adapter generator
// npx meridian generate --provider acme --openapi ./acme.json
// → adapter.ts  adapter.test.ts  pagination.ts  index.ts (8 tests pass immediately)

// Pagination
for await (const page of meridian.provider("stripe")!.paginate("/v1/customers")) { ... }

// Streaming (OpenAI, Anthropic, Gemini, Mistral, Cohere)
for await (const chunk of meridian.provider("openai")!.stream("/v1/chat/completions", { body })) { ... }

// Batch
await meridian.provider("stripe")!.batch([{ method: "GET", endpoint: "/v1/customers/1" }, ...], 5);

// Webhook verification
new StripeAdapter().verifyWebhook(req.rawBody, req.headers["stripe-signature"], secret);

// UPI helpers (NPCI spec — no network call)
import { validateVpa, createUpiDeepLink } from "meridianjs/upi";
validateVpa("merchant@oksbi");                              // true
createUpiDeepLink({ vpa: "merchant@oksbi", amount: 1000 }); // "upi://pay?pa=..."
```

**Subpath exports:** `meridianjs` (core) · `meridianjs/contract` (test harness) · `meridianjs/upi` (UPI helpers)

---

## Providers

**45 adapters**, each passing the same 19 contract invariants (855 contract tests in total). Verify any one with `npm run test:contracts stripe`.

| Category | Count | Providers |
|---|---|---|
| **Payments** | 13 | Stripe · Razorpay · Cashfree · PayU · Juspay · Braintree · Adyen · Klarna · Mollie · PhonePe · Checkout.com · BillDesk · CCAvenue |
| **AI / LLM** | 5 | OpenAI · Anthropic · Gemini · Cohere · Mistral |
| **Communications** | 7 | Twilio · SendGrid · Mailgun · Vonage · MSG91 · Exotel · Gupshup |
| **KYC / Identity** | 7 | HyperVerge · Digio · Karza · IDfy · Setu · Decentro · Perfios |
| **Tools & Infra** | 6 | GitHub · HubSpot · Supabase · Auth0 · Apollo · S3 |
| **Mapping** | 2 | Google Maps · MapMyIndia |
| **Observability** | 2 | Sentry · Datadog |
| **Logistics** | 2 | Shiprocket · Delhivery |
| **Other** | 1 | Cleartax |

---

## Contributing

New adapter: `npx meridian generate --provider name --openapi ./spec.json` → implement TODOs → `npm test`.

[Changelog](CHANGELOG.md) · [License: MIT](LICENSE.md) · [npm](https://www.npmjs.com/package/meridianjs)
