# Payments

Get consistent retries, circuit breakers, and normalized errors across Stripe, Razorpay, Cashfree, and other payment providers — and a clean pattern for routing between them when a primary is down.

## Problem

Every payment provider ships its own SDK, uses different error shapes, and paginates differently. A Stripe customer list call looks nothing like a Razorpay order list. When you want to add a second provider for redundancy or regional coverage, you're rewriting integration logic — not just swapping a config value.

## Without Meridian

```typescript
// Three different SDKs, three different error models
import Stripe from "stripe";
import Razorpay from "razorpay";

const stripe = new Stripe(process.env.STRIPE_KEY!);
const razorpay = new Razorpay({ key_id: process.env.RZP_KEY!, key_secret: process.env.RZP_SECRET! });

async function chargeCustomer(amount: number, currency: string) {
  try {
    return await stripe.paymentIntents.create({ amount, currency });
  } catch (err: any) {
    if (err.type === "StripeConnectionError") {
      // Now rewrite the call in Razorpay's shape — manually
      return await razorpay.orders.create({ amount: amount * 100, currency });
    }
    throw err;
  }
}

// Pagination: completely different per provider
const stripeCustomers = await stripe.customers.list({ limit: 100 });
// vs razorpay: offset-based, different field names
```

## With Meridian

Stripe and Razorpay don't share a request/response shape (`/v1/charges` with `source` vs `/v1/orders` with `receipt`), and a charge is a `POST` — Meridian's `service()` abstraction never auto-fails-over a write, since a different provider has no way to know whether the original charge already happened (see [docs/failover/index.md](../failover/index.md)). Unifying them means calling each directly and writing a small amount of routing yourself; what Meridian still gives you on *each* call is retry, a circuit breaker, and normalized errors:

```typescript
import { Meridian, MeridianError } from "meridianjs";

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

async function charge(amount: number, currency: string, orderId: string) {
  if (meridian.getCircuitStatus("stripe")?.state !== "OPEN") {
    try {
      const { data } = await meridian.provider("stripe")!.post<{ id: string }>("/v1/charges", {
        idempotencyKey: `charge_${orderId}`,
        body: { amount, currency },
      });
      return { provider: "stripe", chargeId: data.id };
    } catch (err) {
      if (!(err instanceof MeridianError) || !["provider", "network"].includes(err.category)) throw err;
    }
  }

  const { data } = await meridian.provider("razorpay")!.post<{ id: string }>("/v1/orders", {
    body: { amount, currency: currency.toUpperCase(), receipt: `receipt_${orderId}` },
  });
  return { provider: "razorpay", chargeId: data.id };
}

// Pagination works the same regardless of provider
for await (const page of meridian.provider("stripe")!.paginate("/v1/customers")) {
  console.log(page); // normalized page shape
}
```

The same pattern extends to Cashfree, PayU, or any other payment provider you add — each gets its own `provider()` entry and a branch in `charge()`'s routing.

## Production Example

A checkout endpoint that survives a Stripe outage by falling over to Razorpay:

```typescript
// POST /checkout
export async function handleCheckout(req: Request): Promise<Response> {
  const { amount, currency, userId } = await req.json();

  const result = await charge(amount, currency, userId);

  return Response.json({
    chargeId: result.chargeId,
    provider: result.provider,   // "razorpay" if Stripe's circuit was open
    health:   meridian.health(),
    // { stripe: { status: "down", circuitBreaker: "OPEN" }, razorpay: { status: "healthy", ... } }
  });
}

// Inspect analytics after load
const stats = meridian.analytics();
// { stripe: { requests: 41, errorRate: "100%", avgLatency: 5020 },
//   razorpay: { requests: 312, errorRate: "0.3%", avgLatency: 190 } }
```
