# Stripe Downtime Cost Us Money. Here's How We Fixed It.

Payment providers don't go down often. But when they do, the failure is expensive: abandoned carts, failed subscriptions, revenue lost to a provider you're paying for uptime.

This is how to make your Stripe integration resilient — and how to build a payment failover strategy that doesn't require rewriting your checkout on short notice.

---

## The failure modes that actually happen

Stripe's outages are rarely total. They look like:

- **429 Too Many Requests** — burst traffic, Stripe rate-limits you. Your customers retry manually. Most don't.
- **503 Service Unavailable** — usually on a specific API endpoint (`/v1/payment_intents`). Other endpoints still work.
- **Timeout** — a network partition between your region and Stripe's servers. Requests hang; users assume the payment failed and abandon.
- **Schema change** — Stripe updates a field name silently. Your code starts writing `undefined` to your database.

Each failure mode needs a different response. Raw SDK calls handle none of them.

---

## Handling 429s: automatic retry with backoff

Stripe's 429 responses include a `Retry-After` header. Most code ignores it:

```typescript
// Without retry — a 429 becomes an exception
const charge = await stripe.charges.create({ amount: 2000, currency: "usd", source: "tok_visa" });
```

With retry configured in Meridian:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: {
      auth: { apiKey: process.env.STRIPE_KEY },
      retry: {
        maxRetries: 4,
        baseDelay: 500,    // 500ms, 1s, 2s, 4s — exponential
        maxDelay: 10_000,
        jitter: true,      // prevents thundering herd
      },
    },
  },
});

const { data, meta } = await meridian.provider("stripe")!.post("/v1/charges", {
  body: { amount: 2000, currency: "usd", source: "tok_visa" },
});

console.log(meta.trace.retries);  // 2 — succeeded on third attempt
```

The pipeline parses the `Retry-After` header, waits the specified duration (or falls back to exponential backoff), and retries. Your application sees a successful charge.

**Critical: retries are only attempted for safe operations.** A `POST /v1/charges` with an idempotency key is safe to retry; without one, retrying a charge can double-charge a customer. Meridian gates retries on idempotency:

```typescript
await meridian.provider("stripe")!.post("/v1/charges", {
  idempotencyKey: `charge_${orderId}`,    // safe to retry
  body: { amount: 2000, currency: "usd", source: "tok_visa" },
});
```

---

## Handling outages: failover to Razorpay

If the outage is total and retries fail, you need a fallback payment processor. The challenge is that Stripe and Razorpay have different APIs — `/v1/charges` with `source` vs `/v1/orders` with `receipt`. There's no single endpoint+body that's valid for both, so Meridian's `service()` abstraction (one call, one shape, routed to whichever provider a strategy picks) doesn't fit here — it's built for providers that *do* share a contract, and even then it only auto-fails-over idempotent methods, never a charge (`POST`). A different provider has no way to know whether your first charge attempt already succeeded, so replaying it risks billing the customer twice. See [docs/failover/index.md](../docs/failover/index.md).

What Meridian *does* give you for free on each leg is retry, a circuit breaker, and normalized errors — call each provider directly and write the ~10 lines of routing yourself:

```typescript
import { Meridian, MeridianError } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { auth: { apiKey: process.env.STRIPE_KEY } },
    razorpay: { auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET } },
  },
});

async function charge(amount: number, currency: string, orderId: string) {
  // Skip straight to Razorpay if Stripe's breaker is already open — no
  // point waiting for a timeout you already know is coming.
  if (meridian.getCircuitStatus("stripe")?.state !== "OPEN") {
    try {
      const { data } = await meridian.provider("stripe")!.post("/v1/charges", {
        idempotencyKey: `charge_${orderId}`,
        body: { amount, currency, source: "tok_visa" },
      });
      return { provider: "stripe", data };
    } catch (err) {
      if (!(err instanceof MeridianError) || !["provider", "network"].includes(err.category)) throw err;
      // fall through to Razorpay below
    }
  }

  const { data } = await meridian.provider("razorpay")!.post("/v1/orders", {
    body: { amount, currency: currency.toUpperCase(), receipt: `receipt_${orderId}` },
  });
  return { provider: "razorpay", data };
}
```

Each call still gets Stripe's and Razorpay's own retry/circuit-breaker/normalized-error handling — you're just the one deciding when to hop providers and how to translate the request, which is unavoidable once the two APIs genuinely disagree on shape.

For a seamless checkout experience, hide the provider selection from the user entirely and handle response normalisation in an adapter layer specific to your application.

---

## Weighted split: reduce dependency before an outage

Waiting for an outage to test Razorpay means debugging payment failures in production. A better strategy is continuous low-traffic routing to your backup — before an outage forces your hand.

This is still application code, not a `service()` config, for the same reason as failover: there's no single endpoint+body valid for both providers. It's a small dispatch function on top of the same `meridian.provider()` calls:

```typescript
function pickProvider(weights: Record<string, number>): string {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const [provider, weight] of Object.entries(weights)) {
    cumulative += weight;
    if (roll < cumulative) return provider;
  }
  return Object.keys(weights)[0]!;
}

const provider = pickProvider({ stripe: 95, razorpay: 5 }); // 5% to Razorpay continuously
const { data } =
  provider === "stripe"
    ? await meridian.provider("stripe")!.post("/v1/charges", { body: { amount, currency, source: "tok_visa" } })
    : await meridian.provider("razorpay")!.post("/v1/orders", {
        body: { amount, currency: currency.toUpperCase(), receipt: `receipt_${orderId}` },
      });
```

This keeps your Razorpay integration warm and tested. During an outage, shift `weights` to `{ stripe: 0, razorpay: 100 }` — no redeployment needed if weights come from config, no surprises because you've been running real payments through Razorpay already.

---

## Circuit breaking: stop burning Stripe's timeout

When Stripe is returning 503s, every payment request waits for Stripe's 10-second timeout before failing. At 50 transactions per minute, that's 500 seconds of wasted capacity and 50 abandoned carts per minute.

A circuit breaker on the Stripe provider opens after the first 5 failures:

```typescript
providers: {
  stripe: {
    auth: { apiKey: process.env.STRIPE_KEY },
    circuitBreaker: {
      failureThreshold: 5,       // open after 5 consecutive failures
      timeout: 60_000,           // try stripe again after 1 minute
      volumeThreshold: 10,
      rollingWindowMs: 60_000,
      errorThresholdPercentage: 50,
    },
  },
}
```

That's exactly what the `charge()` function above checks with `meridian.getCircuitStatus("stripe")?.state !== "OPEN"` — once the breaker opens, that check fails fast (under 1ms, no network call) and routes straight to Razorpay, instead of waiting out Stripe's 10-second timeout on every request. When the breaker's `timeout` expires, one probe request checks if Stripe recovered; if it succeeds, the breaker closes and `charge()` starts trying Stripe again automatically — you don't need to change the routing logic, only the breaker's internal state changes.

Once open, the `payments` service skips Stripe entirely. When the timeout expires, one probe request checks if Stripe recovered; if it succeeds, the circuit closes and traffic returns to Stripe automatically.

---

## Schema drift: catch silent breaking changes

Stripe updated their API on a Tuesday. The `customer` object now has `customer_name` instead of `name`. Your code still writes `res.name` — which is now `undefined`. Three days later a support ticket arrives.

Snapshot the response schema and monitor for drift:

```typescript
const { data } = await meridian.provider("stripe")!.get("/v1/customers/cus_abc");

// First run: snapshot the schema
await meridian.schema.snapshot("stripe", "/v1/customers", data);

// Every subsequent run: detect drift
const drifts = await meridian.schema.check("stripe", "/v1/customers", data);
if (drifts.length > 0) {
  // [{ type: "FIELD_REMOVED", field: "name", severity: "ERROR" }]
  alert(drifts);
}
```

Run this as part of your CI nightly job against the live API. Drift is caught before it ships.

---

## What your payment dashboard should show

```typescript
const health = meridian.health();
// {
//   stripe:   { status: "down",    circuitBreaker: "OPEN",   successRate: "23.4%" },
//   razorpay: { status: "healthy", circuitBreaker: "CLOSED", successRate: "100.0%" },
// }

const analytics = meridian.analytics();
// {
//   stripe:   { requests: 1200, errorRate: "76.6%", avgLatency: 8340 },
//   razorpay: { requests:   93, errorRate:  "0.0%", avgLatency:  280 },
// }
```

When `stripe.status === "down"`, page your on-call. The circuit breaker keeps the checkout flowing in the meantime.

---

## See also

- [Circuit breaker internals](../docs/circuit-breaker.md)
- [Routing strategies](../docs/failover/index.md)
- [Schema drift detection](../docs/schema-drift/index.md)
