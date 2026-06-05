# Payments

Normalize Stripe, Razorpay, and Cashfree behind a single interface with automatic failover.

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
    cashfree: {
      baseUrl: "https://api.cashfree.com",
      auth: { type: "bearer", token: process.env.CASHFREE_KEY! },
    },
  },
  services: {
    payments: {
      providers: ["stripe", "razorpay", "cashfree"],
      strategy: "failover",
    },
  },
});

// One call — Meridian handles failover transparently
const { data, meta } = await meridian.service("payments")!.post("/v1/charges", {
  body: { amount: 5000, currency: "inr" },
});

console.log(meta.trace.retries);         // how many retries it took
console.log(meta.trace.circuitBreaker);  // "CLOSED" | "OPEN" | "HALF_OPEN"

// Pagination works the same regardless of provider
for await (const page of meridian.provider("stripe")!.paginate("/v1/customers")) {
  console.log(page); // normalized page shape
}
```

## Production Example

Checkout flow that survives a Stripe outage by falling over to Razorpay, then Cashfree:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { baseUrl: "https://api.stripe.com",   auth: { type: "bearer", token: process.env.STRIPE_KEY! },   retry: { attempts: 2 } },
    razorpay: { baseUrl: "https://api.razorpay.com", auth: { type: "basic",  username: process.env.RZP_KEY!, password: process.env.RZP_SECRET! }, retry: { attempts: 2 } },
    cashfree: { baseUrl: "https://api.cashfree.com", auth: { type: "bearer", token: process.env.CASHFREE_KEY! }, retry: { attempts: 2 } },
  },
  services: {
    payments: { providers: ["stripe", "razorpay", "cashfree"], strategy: "failover" },
  },
});

// POST /checkout
export async function handleCheckout(req: Request): Promise<Response> {
  const { amount, currency, userId } = await req.json();

  const { data, meta } = await meridian.service("payments")!.post("/v1/charges", {
    body: { amount, currency, metadata: { userId } },
  });

  // Which provider actually handled it?
  const health = meridian.health();
  // { stripe: { status: "down", circuitBreaker: "OPEN" }, razorpay: { status: "healthy", ... } }

  return Response.json({
    chargeId: data.id,
    provider: meta.trace.provider,   // "razorpay" — Stripe was down
    latency: meta.trace.latency,
    retries: meta.trace.retries,
    health,
  });
}

// Inspect analytics after load
const stats = meridian.analytics();
// { stripe: { requests: 41, errorRate: "100%", avgLatency: 5020 },
//   razorpay: { requests: 312, errorRate: "0.3%", avgLatency: 190 } }
```
