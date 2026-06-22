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

```typescript
import { Meridian, MeridianError, blockPII } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    razorpay: { auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET } },
  },
  policies: [blockPII(["stripe", "razorpay"])],
});
```

Note there's no `services: { payments: {...} }` config here. Meridian's `service()` abstraction works when every configured provider shares one endpoint and body shape — true for things like two SMS senders, not true for Stripe vs Razorpay: `/v1/payment_intents` with `source` vs `/v1/orders` with `receipt`. There's no single call that's valid for both, so unifying them means calling each directly and writing a small amount of routing yourself. What you still get from Meridian on *each* call: retry, a circuit breaker, normalized errors, and analytics — identically, regardless of which provider you're calling.

```typescript
// Direct provider access — Meridian still normalizes errors/retries/breaker state per call
const { data } = await meridian.provider("stripe")!.get("/v1/customers");
const { data } = await meridian.provider("razorpay")!.get("/v1/payments");
```

## Weighted Routing: 70% Stripe, 30% Razorpay

A small dispatch function picks the provider, then calls it with its own shape:

```typescript
function pickProvider(weights: Record<string, number>): "stripe" | "razorpay" {
  const roll = Math.random() * 100;
  return roll < weights.stripe! ? "stripe" : "razorpay";
}

async function charge(amount: number, currency: string, orderId: string) {
  const provider = pickProvider({ stripe: 70, razorpay: 30 });
  const { data, meta } =
    provider === "stripe"
      ? await meridian.provider("stripe")!.post("/v1/payment_intents", { body: { amount, currency } })
      : await meridian.provider("razorpay")!.post("/v1/orders", {
          body: { amount, currency: currency.toUpperCase(), receipt: `receipt_${orderId}` },
        });
  return { provider, data, meta };
}
```

Adjust weights as your confidence grows — no code change beyond the numbers passed to `pickProvider`:

```typescript
pickProvider({ stripe: 50, razorpay: 50 })  // balanced split
pickProvider({ stripe: 20, razorpay: 80 })  // Razorpay-primary for INR cost savings
```

## Automatic Failover

For payments, you want degradation on the primary to route to the backup immediately, instead of continuing to split traffic to a provider that's down. Check the breaker before committing to Stripe:

```typescript
async function chargeWithFailover(amount: number, currency: string, orderId: string) {
  if (meridian.getCircuitStatus("stripe")?.state !== "OPEN") {
    try {
      const { data } = await meridian.provider("stripe")!.post("/v1/payment_intents", {
        idempotencyKey: `charge_${orderId}`,
        body: { amount, currency },
      });
      return { provider: "stripe", data };
    } catch (err) {
      if (!(err instanceof MeridianError) || !["provider", "network"].includes(err.category)) throw err;
    }
  }

  const { data } = await meridian.provider("razorpay")!.post("/v1/orders", {
    body: { amount, currency: currency.toUpperCase(), receipt: `receipt_${orderId}` },
  });
  return { provider: "razorpay", data };
}
```

Check the health of both providers at any time:

```typescript
const health = meridian.health();
// {
//   stripe:   { status: "healthy",  successRate: "99.9%", circuitBreaker: "CLOSED" },
//   razorpay: { status: "degraded", successRate: "87.3%", circuitBreaker: "OPEN"   }
// }
```

When Stripe's circuit breaker is `OPEN`, the `meridian.getCircuitStatus("stripe")?.state !== "OPEN"` check above fails fast (under 1ms, no network call) and `chargeWithFailover` routes straight to Razorpay. When Stripe recovers, the breaker closes and the function starts trying Stripe again automatically — the routing code itself never changes, only the breaker's internal state does. A different provider has no way to know whether your first attempt actually went through, so this only ever applies before a charge succeeds, never as a blind retry of one that might have.

## Normalized Errors

One of the less-glamorous benefits: a single error type regardless of which provider failed.

```typescript
try {
  await meridian.provider("stripe")!.post("/v1/payment_intents", {
    body: { amount: 50000, currency: "inr" },
  });
} catch (err) {
  if (err instanceof MeridianError) {
    console.log(err.provider);    // "stripe"
    console.log(err.category);    // normalized category — "auth" | "rate_limit" | "network" | "provider" | "validation"
    console.log(err.message);     // human-readable
  }
}
```

Your error handling logic doesn't need an `if provider === "stripe" ... else if provider === "razorpay"` branch on the *shape* of the error — `category`/`retryable`/`provider` are the same fields no matter which adapter threw. You still branch on `err.provider` to decide which endpoint to retry against, same as the routing functions above.

This pattern extends cleanly to other Indian payment providers as you need them — Cashfree for payouts, PayU for EMI flows, PhonePe for UPI-first experiences, Juspay for smart routing. Each addition gets the same retry/circuit-breaker/error-normalization for free; your dispatch function grows by one branch.

`npm install meridianjs` — full docs and provider guides at [npmjs.com/package/meridianjs](https://www.npmjs.com/package/meridianjs).
