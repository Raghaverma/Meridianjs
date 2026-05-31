<div align="center">

# Meridian

**One SDK. Every API. Zero inconsistency.**

[![npm version](https://img.shields.io/npm/v/meridianjs?color=0070f3&label=npm)](https://www.npmjs.com/package/meridianjs)
[![npm downloads](https://img.shields.io/npm/dm/meridianjs?color=0070f3)](https://www.npmjs.com/package/meridianjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-693%20passing-brightgreen)](https://vitest.dev)
[![Adapters](https://img.shields.io/badge/adapters-36-blueviolet)](#providers)

A TypeScript-first SDK that gives every third-party API the same interface — normalized errors, rate limits, pagination, and response shapes, regardless of provider.

</div>

---

## Install

```bash
npm install meridianjs
```

Requires **Node.js ≥ 18**. Zero runtime dependencies.

---

## Quick Start

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    razorpay: {
      auth: {
        username: process.env.RAZORPAY_KEY_ID,
        password: process.env.RAZORPAY_KEY_SECRET,
      },
    },
  },
});

// Same API for every provider
const { data, meta } = await meridian.provider("stripe").get("/v1/customers");

console.log(meta.provider);            // "stripe"
console.log(meta.rateLimit.remaining); // always normalized
console.log(meta.pagination.hasNext);  // always normalized
```

Switch providers — your app code doesn't change.

---

## What It Does

| Feature | Description |
|---|---|
| **Normalized responses** | Every provider returns `{ data, meta }` with consistent shape |
| **Typed errors** | `MeridianError` with `category`, `retryable`, `retryAfter` — always |
| **Auto-retry** | Exponential backoff with jitter on 429s and 5xx errors |
| **Circuit breaker** | Opens automatically on repeated failures, closes after cooldown |
| **Rate limit awareness** | Tracks limits from response headers, delays before hitting 429 |
| **Pagination** | Unified `meta.pagination` across cursor, offset, and link-based strategies |
| **Webhook verification** | Timing-safe HMAC verification on every payment/comms adapter |
| **Streaming** | SSE streaming for OpenAI, Anthropic, Mistral, Cohere |
| **Batch requests** | Fan-out with concurrency control via `.batch()` |
| **India Compliance** | DPDPA-compliant PII redaction (Aadhaar, PAN, UPI VPA, bank accounts) |

---

## Providers

### 🇮🇳 Indian Ecosystem (17 adapters)

| Category | Providers |
|---|---|
| Payments | Razorpay, Cashfree, PayU, Juspay, PhonePe |
| Banking / UPI | Setu, Decentro |
| Communications | MSG91, Exotel, Gupshup |
| Logistics | Shiprocket, Delhivery |
| KYC / Identity | HyperVerge, Digio, Karza, IDfy |
| Tax / Maps | Cleartax, MapMyIndia, Perfios |

### 🌐 International (19 adapters)

| Category | Providers |
|---|---|
| Payments | Stripe, Adyen, Braintree, Checkout.com, Mollie, Klarna |
| Communications | Twilio, SendGrid, Mailgun, Vonage |
| AI / LLM | OpenAI, Anthropic, Google Gemini, Cohere, Mistral |
| CRM / Dev Tools | HubSpot, Auth0, Supabase, GitHub |

---

## Error Handling

Every error has the same shape — no more `try/catch` archaeology per provider:

```typescript
try {
  const result = await meridian.provider("stripe").post("/v1/charges", { body });
} catch (err) {
  if (err instanceof MeridianError) {
    err.category;   // "auth" | "rate_limit" | "validation" | "network" | "provider"
    err.retryable;  // boolean
    err.retryAfter; // Date | undefined
    err.provider;   // "stripe"
  }
}
```

---

## Webhook Verification

```typescript
import { StripeAdapter } from "meridianjs";

const adapter = new StripeAdapter();
const valid = adapter.verifyWebhook(
  req.rawBody,
  req.headers["stripe-signature"],
  process.env.STRIPE_WEBHOOK_SECRET,
);
```

Works identically for Razorpay, Cashfree, Braintree, Twilio, Adyen, and more.

---

## Batch Requests

```typescript
const results = await meridian.provider("stripe").batch([
  { method: "GET", endpoint: "/v1/customers/cu_1" },
  { method: "GET", endpoint: "/v1/customers/cu_2" },
  { method: "GET", endpoint: "/v1/customers/cu_3" },
], 5); // max 5 concurrent

// Results are always in input order; errors are MeridianError, never thrown
```

---

## Links

- [GitHub](https://github.com/Raghaverma/Meridianjs)
- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [License: MIT](LICENSE.md)
