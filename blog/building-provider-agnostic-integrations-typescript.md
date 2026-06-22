---
title: "Building Provider-Agnostic API Integrations in TypeScript"
description: "Stop coupling your app to vendor SDKs. Here's how a service abstraction layer gives you failover, analytics, and health monitoring for free."
tags: typescript, api, architecture, backend, reliability
date: 2026-06-05
---

# Building Provider-Agnostic API Integrations in TypeScript

Your app is probably married to at least three vendor SDKs right now. Stripe's SDK. OpenAI's SDK. SendGrid's SDK. Each one has its own initialization pattern, its own error class, its own retry behavior (or lack of one), and its own way of paginating results.

This isn't a problem until it is. When you need to add a fallback payment processor, or A/B test two LLM providers, or swap email vendors, you realize: your business logic is tangled with the vendor's SDK. The abstraction you thought you had isn't an abstraction — it's just a thin wrapper that still leaks the vendor's types everywhere.

The fix is a service abstraction layer. Not a custom one you build and maintain — one you configure.

## The Coupling Problem

Here's what direct SDK usage looks like in practice:

```typescript
import Stripe from "stripe";
import OpenAI from "openai";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Business logic hardcoded to Stripe
async function chargeCustomer(customerId: string, amount: number) {
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    customer: customerId,
  });
  return paymentIntent;
}

// Business logic hardcoded to OpenAI
async function summarize(text: string) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: `Summarize: ${text}` }],
  });
  return res.choices[0].message.content;
}
```

Nothing in `chargeCustomer` is conceptually Stripe-specific. You're creating a payment. But every line of it is Stripe. If Razorpay becomes the better option for your market next year, you're rewriting this function — and every test that uses it, and every mock that depends on its shape.

## What Provider-Agnostic Looks Like

Install Meridian.js:

```bash
npm install meridianjs
```

Configure providers and services:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:    { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
    stripe:    { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    razorpay:  { auth: { apiKey: process.env.RAZORPAY_KEY_ID } },
  },
  services: {
    llm: {
      providers: ["openai", "anthropic"],
      strategy: "failover",
    },
    payments: {
      providers: ["stripe", "razorpay"],
      strategy: "weighted",
      weights: { stripe: 70, razorpay: 30 },
    },
  },
});
```

Now your business logic calls a service, not a vendor:

```typescript
// Before: hardcoded to OpenAI
const res = await openai.chat.completions.create({ model: "gpt-4o", ... });

// After: provider-agnostic — GET is idempotent, so it's safe to fail over
const { data, meta } = await meridian.service("llm")!.get("/v1/models");
// meta.provider tells you which provider actually answered
```

> A chat completion is a `POST`, and Meridian's service layer never auto-fails-over
> a write — a different provider has no way to know whether the original attempt
> already happened. For OpenAI/Anthropic chat completions specifically, use
> [`meridianjs/ai`](../docs/ai-sdk.md) instead: the Vercel AI SDK already normalizes
> both providers into one interface, so failover (even on a completion call) is both
> possible and safe there, because providers only bill for output actually returned.

```typescript
// Before: hardcoded to Stripe
const pi = await stripe.paymentIntents.create({ amount, currency: "usd" });

// After: provider-agnostic where providers share a shape (e.g. a read like
// listing customers). A charge is a POST, and Stripe/Razorpay use different
// endpoints and fields (/v1/payment_intents vs /v1/orders), so weighted
// routing between them is one small dispatch function, not a single
// endpoint string — see the caveat below.
const { data } = await meridian.provider("stripe")!.get("/v1/customers");
```

The call site doesn't know or care whether OpenAI or Anthropic answered for an LLM call. For payments specifically, your dispatch function is the thing that doesn't care *which provider's branch ran* — both still get the same retry/circuit-breaker/error normalization. See [docs/failover/index.md](../docs/failover/index.md).

## Operational Benefits You Get For Free

The moment you route through a service abstraction, you get instrumentation without writing any:

```typescript
// Which provider handled this request, and how it went
console.log(meta.provider);             // "openai"
console.log(meta.trace.latency);        // 312 (ms)
console.log(meta.trace.retries);        // 1
console.log(meta.trace.circuitBreaker); // "CLOSED"

// Aggregate analytics across all providers
meridian.analytics();
// {
//   openai:    { requests: 1000, errorRate: "0.5%", avgLatency: 320, p95Latency: 650 },
//   anthropic: { requests: 50,   errorRate: "0.0%", avgLatency: 280, p95Latency: 490 }
// }

// Health status per provider
meridian.health();
// {
//   stripe:   { status: "healthy",  successRate: "99.9%", circuitBreaker: "CLOSED" },
//   razorpay: { status: "degraded", successRate: "88.1%", circuitBreaker: "OPEN"   }
// }
```

This data is available without a third-party APM agent, without custom middleware, without anything beyond the Meridian config you already wrote.

## Architecture

```
┌─────────────────────────────────────────┐
│              Your Application           │
│                                         │
│  meridian.service("llm").post(...)      │
│  meridian.service("payments").post(...) │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│           Meridian Service Layer        │
│                                         │
│  ┌─────────────┐   ┌─────────────────┐  │
│  │  Strategy   │   │  Circuit Breaker│  │
│  │  (failover/ │   │  (per provider) │  │
│  │  weighted/  │   └─────────────────┘  │
│  │  latency)   │   ┌─────────────────┐  │
│  └─────────────┘   │  Analytics/     │  │
│                    │  Health Tracker │  │
│                    └─────────────────┘  │
└──────┬──────────────────┬───────────────┘
       │                  │
┌──────▼──────┐    ┌──────▼──────┐
│   OpenAI    │    │  Anthropic  │
│   Stripe    │    │  Razorpay   │
└─────────────┘    └─────────────┘
```

The service layer is the only place that knows about providers. Everything above it is vendor-neutral.

One caveat that applies regardless of strategy: failover only ever happens for idempotent
methods (`GET`/`PUT`/`DELETE`). A `payments` service split with `weighted` still sends each
*new* charge to whichever provider the weights pick — but if that provider is down mid-charge,
the request fails with a clear error instead of silently retrying on the other one, which could
double-charge the customer. See [docs/failover/index.md](../docs/failover/index.md).

## When NOT to Use This Pattern

This pattern adds a configuration layer. For some apps, that's unnecessary complexity.

**Skip it if:**
- You have a single provider per function and no plans to change it
- You're building a proof of concept or internal tool with low reliability requirements
- Your traffic is low enough that provider downtime is acceptable

**Use it if:**
- You need uptime guarantees that depend on more than one provider's reliability
- You're in a market where multiple payment processors serve different customer segments
- You want analytics on external API calls without instrumenting them manually
- You anticipate switching or adding providers in the next 12 months

The migration cost to a service abstraction grows with your codebase. Adding it early is cheap. Adding it after 50 files directly import Stripe is a refactor.

`npm install meridianjs` — full docs at [npmjs.com/package/meridianjs](https://www.npmjs.com/package/meridianjs).
