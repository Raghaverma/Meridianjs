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

## Production Example

Payments service using weighted 70/30 India vs global, with geo override:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: {
      baseUrl: "https://api.stripe.com",
      auth: { type: "bearer", token: process.env.STRIPE_KEY! },
      retry: { attempts: 3, backoff: "exponential" },
    },
    razorpay: {
      baseUrl: "https://api.razorpay.com",
      auth: { type: "basic", username: process.env.RZP_KEY!, password: process.env.RZP_SECRET! },
      retry: { attempts: 3, backoff: "exponential" },
    },
  },
  services: {
    // Default: weighted split
    payments: {
      providers: ["stripe", "razorpay"],
      strategy: "weighted",
      weights: { stripe: 70, razorpay: 30 },
    },
    // India-specific traffic: geo routing forces Razorpay
    paymentsIndia: {
      providers: ["razorpay", "stripe"],
      strategy: "geo",
      regions: {
        "ap-south-1": ["razorpay"],
        "us-east-1":  ["stripe"],
        "eu-west-1":  ["stripe"],
      },
    },
  },
});

export async function charge(amount: number, currency: string, region: string) {
  const service = region === "ap-south-1" ? "paymentsIndia" : "payments";

  const { data, meta } = await meridian.service(service)!.post("/v1/charges", {
    body: { amount, currency },
  });

  return {
    chargeId:  data.id,
    provider:  meta.trace.provider,  // "razorpay" for India, weighted split elsewhere
    latency:   meta.trace.latency,
    analytics: meridian.analytics(),
  };
}
```
