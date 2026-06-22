# Failover & Routing Strategies

Choose how Meridian distributes requests across providers — from simple failover to geo-aware routing.

## Problem

Provider outages are inevitable. When they happen, requests fail unless you've written routing logic by hand. Beyond uptime, different providers have different costs, latencies, and regional performance. Optimal routing (cheapest, fastest, healthiest) is even harder to implement correctly than simple failover.

## Without Meridian

```typescript
// Manual failover — no circuit breaker, no latency tracking, no weighted split
async function callLLM(body: object) {
  for (const provider of ["openai", "anthropic", "gemini"]) {
    try {
      return await callProvider(provider, body); // custom per-provider logic
    } catch (err: any) {
      if (provider === "gemini") throw err; // exhausted all options
    }
  }
}
// Weighted, geo, cheapest, round-robin: you're writing all of this yourself.
```

## With Meridian

Meridian supports 7 routing strategies. Configure per service; mix strategies across services.

**failover** — try providers in order; move to next on error:
```typescript
services: {
  llm: { providers: ["openai", "anthropic", "gemini"], strategy: "failover" },
}
```

**round-robin** — distribute load evenly across all healthy providers:
```typescript
services: {
  embeddings: { providers: ["openai", "cohere"], strategy: "round-robin" },
}
```

**lowest-latency** — route to the provider with the best recent p95 latency:
```typescript
services: {
  search: { providers: ["algolia", "typesense", "meilisearch"], strategy: "lowest-latency" },
}
```

**cheapest** — route to the provider with the lowest declared cost per request:
```typescript
services: {
  embeddings: {
    providers: ["openai", "cohere"],
    strategy: "cheapest",
    costs: { openai: 0.0001, cohere: 0.00004 },
  },
}
```

**highest-success-rate** — route to the provider with the best recent success rate:
```typescript
services: {
  sms: { providers: ["twilio", "msg91", "sinch"], strategy: "highest-success-rate" },
}
```

**weighted** — split traffic by percentage:
```typescript
services: {
  payments: {
    providers: ["stripe", "razorpay"],
    strategy: "weighted",
    weights: { stripe: 70, razorpay: 30 },
  },
}
```

**geo** — route by AWS/GCP region of the caller:
```typescript
services: {
  regional: {
    providers: ["razorpay", "stripe"],
    strategy: "geo",
    regions: {
      "ap-south-1": ["razorpay"],
      "us-east-1":  ["stripe"],
    },
  },
}
```

## Writes are never replayed on another provider

Every strategy above only fails over for **idempotent** methods — `GET`, `PUT`,
`DELETE`. A failed `POST`/`PATCH` (a charge, a chat completion, anything with a
side effect) surfaces its error immediately instead of retrying on the next
provider: the second provider never saw the first attempt, so it can't know
whether the side effect already happened. Silently replaying it risks a
duplicate charge or a duplicate LLM call billed twice.

This means a `weighted`/`geo` payments service still splits *new* charges
across providers as configured — but if the provider selected for a given
charge is down, that charge fails with a clear, categorized error rather than
silently retrying against the other provider. Decide the safe recovery
yourself (idempotency key + manual retry, queue for reconciliation, etc.).

## Production Example

Stripe and Razorpay don't share a request/response shape (`/v1/charges` with `source` vs `/v1/orders` with `receipt`), so — same as every payments example in this doc set — routing between them is a small dispatch function over direct `provider()` calls, not a single `service().post()` call. Weighted 70/30 split, with a geo override forcing Razorpay for Indian traffic:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: {
      baseUrl: "https://api.stripe.com",
      auth: { token: process.env.STRIPE_KEY! },
      retry: { maxRetries: 3, baseDelay: 500, maxDelay: 8_000 },
    },
    razorpay: {
      baseUrl: "https://api.razorpay.com",
      auth: { username: process.env.RZP_KEY!, password: process.env.RZP_SECRET! },
      retry: { maxRetries: 3, baseDelay: 500, maxDelay: 8_000 },
    },
  },
});

function pickProvider(region: string): "stripe" | "razorpay" {
  if (region === "ap-south-1") return "razorpay"; // geo override: India always Razorpay
  return Math.random() * 100 < 70 ? "stripe" : "razorpay"; // weighted 70/30 elsewhere
}

export async function charge(amount: number, currency: string, region: string, orderId: string) {
  const provider = pickProvider(region);

  const { data, meta } =
    provider === "stripe"
      ? await meridian.provider("stripe")!.post<{ id: string }>("/v1/charges", { body: { amount, currency } })
      : await meridian.provider("razorpay")!.post<{ id: string }>("/v1/orders", {
          body: { amount, currency: currency.toUpperCase(), receipt: `receipt_${orderId}` },
        });

  return {
    chargeId:  data.id,
    provider,  // "razorpay" for India, weighted split elsewhere
    latency:   meta.trace?.latency,
    analytics: meridian.analytics(),
  };
}
```
