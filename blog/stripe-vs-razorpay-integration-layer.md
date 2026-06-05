---
title: "Stripe vs Razorpay: Building a Unified Payment Layer for India"
description: "Indian startups need Stripe for international and Razorpay for domestic. Here's how to unify them behind one API with failover and weighted routing."
tags: stripe, razorpay, payments, typescript, india, fintech
date: 2026-06-05
---

# Stripe vs Razorpay: Building a Unified Payment Layer for India

If you're building a payments product in India, you almost certainly need both. Stripe for international customers — 135+ currencies, global card rails, what your B2B contracts expect. Razorpay for domestic INR — better UPI support, lower fees, faster settlements, NetBanking and NEFT out of the box.

Two providers, two SDKs, one business function.

## The Two-SDK Problem

The surface differences are manageable. The operational differences are not.

```typescript
// Stripe: amount in paise (smallest unit), explicit currency
const intent = await stripe.paymentIntents.create({
  amount: 50000,       // ₹500.00
  currency: "inr",
  payment_method_types: ["card"],
});

// Razorpay: amount in paise too, but different API shape entirely
const order = await razorpay.orders.create({
  amount: 50000,       // ₹500.00
  currency: "INR",
  receipt: `receipt_${Date.now()}`,
});
```

That's just creation. Now consider:

- **Error formats**: `StripeError` has `code`, `decline_code`, `param`. `RazorpayError` has `error.code`, `error.description`, `error.field`. Completely different. Your error handler needs two branches.
- **Pagination**: Stripe uses cursor-based pagination (`starting_after`). Razorpay uses offset-based (`skip`, `count`). If you're listing transactions, you need two implementations.
- **Webhooks**: Different signature verification, different event names, different payload shapes for the same conceptual event (payment succeeded).
- **Retries**: Stripe's SDK has built-in retry logic. Razorpay's does not. You implement it yourself or skip it.

Two providers, two implementations of every feature, two test suites to maintain.

## Unifying Them with Meridian

Install Meridian.js:

```bash
npm install meridianjs
```

Configure both providers under a single `payments` service:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    razorpay: { auth: { apiKey: process.env.RAZORPAY_KEY_ID } },
  },
  services: {
    payments: {
      providers: ["stripe", "razorpay"],
      strategy: "weighted",
      weights: { stripe: 70, razorpay: 30 },
    },
  },
});
```

Your application code now calls a service, not a specific SDK:

```typescript
// One call that routes to Stripe or Razorpay based on weights
const { data, meta } = await meridian.service("payments")!.post("/v1/payment_intents", {
  body: {
    amount: 50000,
    currency: "inr",
  },
});

console.log(meta.provider); // "stripe" or "razorpay" — you can log this per transaction
```

You can still call a specific provider directly when you need to — for instance, when processing a Razorpay webhook that must be verified with Razorpay's signature:

```typescript
// Direct provider access when you need it
const { data } = await meridian.provider("stripe")!.get("/v1/customers");
const { data } = await meridian.provider("razorpay")!.get("/v1/payments");
```

## Weighted Routing: 70% Stripe, 30% Razorpay

The `weighted` strategy sends 70 of every 100 payment requests to Stripe, 30 to Razorpay. This is preferable to geography-based routing when you lack reliable geolocation at the payment step, or when you want to keep Razorpay warm with real traffic before shifting more volume.

Adjust weights as your confidence grows — no code change, just config:

```typescript
weights: { stripe: 50, razorpay: 50 }  // balanced split
weights: { stripe: 20, razorpay: 80 }  // Razorpay-primary for INR cost savings
```

## Automatic Failover

When one provider is down, the weighted strategy continues routing to it until its circuit breaker opens. For payments, you want failover behavior instead — any degradation on the primary should immediately route to the backup:

```typescript
services: {
  payments: {
    providers: ["stripe", "razorpay"],
    strategy: "failover",   // Stripe first, Razorpay only if Stripe fails
  },
},
```

Check the health of both providers at any time:

```typescript
const health = meridian.health();
// {
//   stripe:   { status: "healthy",  successRate: "99.9%", circuitBreaker: "CLOSED" },
//   razorpay: { status: "degraded", successRate: "87.3%", circuitBreaker: "OPEN"   }
// }
```

When Razorpay's circuit breaker is `OPEN`, Meridian routes 100% of traffic to Stripe automatically — no manual intervention, no on-call page required. When Razorpay recovers, the circuit breaker closes and traffic resumes its normal distribution.

## Normalized Errors

One of the less-glamorous benefits: a single error type regardless of which provider failed.

```typescript
import { MeridianError } from "meridianjs";

try {
  const { data } = await meridian.service("payments")!.post("/v1/payment_intents", {
    body: { amount: 50000, currency: "inr" },
  });
} catch (err) {
  if (err instanceof MeridianError) {
    console.log(err.provider);   // "stripe" or "razorpay"
    console.log(err.code);       // normalized error code
    console.log(err.message);    // human-readable
  }
}
```

Your error handling logic doesn't need a `if provider === "stripe" ... else if provider === "razorpay"` branch. One catch block handles both.

## Production Setup for a Fintech Startup

A production-ready config adds PII protection and separates standard payments from high-value transactions:

```typescript
import { Meridian, blockPII } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    razorpay: { auth: { apiKey: process.env.RAZORPAY_KEY_ID } },
  },
  services: {
    payments: {
      providers: ["stripe", "razorpay"],
      strategy: "weighted",
      weights: { stripe: 70, razorpay: 30 },
    },
    payments_critical: {
      providers: ["stripe", "razorpay"],
      strategy: "failover",   // high-value: reliability over distribution
    },
  },
  policies: [blockPII(["stripe", "razorpay"])],
});
```

This pattern extends cleanly to other Indian payment providers as you need them — Cashfree for payouts, PayU for EMI flows, PhonePe for UPI-first experiences, Juspay for smart routing. Each addition is a config block, not a new SDK integration. Your payment business logic never changes.

`npm install meridianjs` — full docs and provider guides at [npmjs.com/package/meridianjs](https://www.npmjs.com/package/meridianjs).
