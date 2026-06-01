<div align="center">

# Meridian

**One SDK. Every API. Zero inconsistency.**

[![npm version](https://img.shields.io/npm/v/meridianjs?color=0070f3&label=npm)](https://www.npmjs.com/package/meridianjs)
[![npm downloads](https://img.shields.io/npm/dm/meridianjs?color=0070f3)](https://www.npmjs.com/package/meridianjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-1489%20passing-brightgreen)](https://vitest.dev)
[![Adapters](https://img.shields.io/badge/adapters-39-blueviolet)](#provider-status-matrix)

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

## Provider Status Matrix

Every adapter in Meridian is held to the **same** contract — adapters are just data sources, so the guarantees Meridian makes (error normalization, retry semantics, rate-limit parsing, pagination, request shaping) must hold identically across all of them. A single, provider-agnostic suite (`runProviderContract`) runs **19 invariants against every registered adapter** in CI, so a provider is only listed here if it upholds the full contract.

```bash
npm run test:contracts          # run the contract against all 39 adapters
npm run test:contracts stripe   # focus a single provider
```

| Provider | Category | Contract Tests | Status |
|:---|:---|:---:|:---:|
| **Adyen** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Anthropic** | AI / LLM | 19/19 Passed | ✅ Production-Ready |
| **Apollo.io** | CRM / Sales | 19/19 Passed | ✅ Production-Ready |
| **Auth0** | Auth / Identity | 19/19 Passed | ✅ Production-Ready |
| **Braintree** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Cashfree** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Checkout.com** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Cleartax** | Tax / Compliance | 19/19 Passed | ✅ Production-Ready |
| **Cohere** | AI / LLM | 19/19 Passed | ✅ Production-Ready |
| **Decentro** | Banking / Fintech | 19/19 Passed | ✅ Production-Ready |
| **Delhivery** | Logistics | 19/19 Passed | ✅ Production-Ready |
| **Digio** | eSign / KYC | 19/19 Passed | ✅ Production-Ready |
| **Exotel** | Communications | 19/19 Passed | ✅ Production-Ready |
| **Google Gemini** | AI / LLM | 19/19 Passed | ✅ Production-Ready |
| **Gupshup** | Communications | 19/19 Passed | ✅ Production-Ready |
| **GitHub** | Developer Tools | 19/19 Passed | ✅ Production-Ready |
| **HubSpot** | CRM | 19/19 Passed | ✅ Production-Ready |
| **HyperVerge** | KYC / Identity | 19/19 Passed | ✅ Production-Ready |
| **IDfy** | KYC / Identity | 19/19 Passed | ✅ Production-Ready |
| **Juspay** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Karza** | KYC / Verification | 19/19 Passed | ✅ Production-Ready |
| **Klarna** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Mailgun** | Communications | 19/19 Passed | ✅ Production-Ready |
| **MapMyIndia** | Maps / Geo | 19/19 Passed | ✅ Production-Ready |
| **Mistral** | AI / LLM | 19/19 Passed | ✅ Production-Ready |
| **Mollie** | Payments | 19/19 Passed | ✅ Production-Ready |
| **MSG91** | Communications | 19/19 Passed | ✅ Production-Ready |
| **OpenAI** | AI / LLM | 19/19 Passed | ✅ Production-Ready |
| **PayU** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Perfios** | Financial Data | 19/19 Passed | ✅ Production-Ready |
| **PhonePe** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Razorpay** | Payments | 19/19 Passed | ✅ Production-Ready |
| **SendGrid** | Communications | 19/19 Passed | ✅ Production-Ready |
| **Setu** | Banking / UPI | 19/19 Passed | ✅ Production-Ready |
| **Shiprocket** | Logistics | 19/19 Passed | ✅ Production-Ready |
| **Stripe** | Payments | 19/19 Passed | ✅ Production-Ready |
| **Supabase** | Database / Auth | 19/19 Passed | ✅ Production-Ready |
| **Twilio** | Communications | 19/19 Passed | ✅ Production-Ready |
| **Vonage** | Communications | 19/19 Passed | ✅ Production-Ready |

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

## Support & Contact

If you encounter any issues or have questions, please reach out directly at [raghav.verma.work@gmail.com](mailto:raghav.verma.work@gmail.com).

---

## Links

- [GitHub](https://github.com/Raghaverma/Meridianjs)
- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [License: MIT](LICENSE.md)
