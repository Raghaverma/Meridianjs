# Migrating from the Stripe SDK to Meridian

This guide walks through converting an app that calls `stripe` directly into one that calls Meridian instead. Request bodies and response shapes stay the same as Stripe's REST API — Meridian doesn't introduce a new schema for charges, customers, or payment intents. What changes is the call shape, error handling, and (optionally) what happens when Stripe itself is degraded.

You can migrate incrementally: Meridian wraps `https://api.stripe.com` directly, so existing `stripe.*` calls and `meridian.provider("stripe")` calls can coexist in the same codebase.

## 1. Install and initialize

```diff
- npm install stripe
+ npm install meridianjs
```

```typescript
// Before
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
```

```typescript
// After
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true, // single instance / local dev — see note below
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_SECRET_KEY! } },
  },
});

const stripe = meridian.provider("stripe")!;
```

`localUnsafe: true` keeps rate-limit and circuit-breaker state in memory — fine for local dev or a single instance. For multi-instance/serverless deployments where you're processing payments, see [Shared State Persistence](../upgrade-guide.md#2-shared-state-persistence-distributed-mode) — you want circuit-breaker state shared across instances so a degraded Stripe doesn't get hammered by every pod independently.

## 2. Resource calls → REST endpoints

The Stripe SDK exposes typed resources (`stripe.customers`, `stripe.paymentIntents`, `stripe.charges`, ...). Meridian gives you `.get/.post/.put/.patch/.delete` against the same endpoints those resources call internally. The request body and response `data` are identical to Stripe's API.

```typescript
// Before
const customer = await stripe.customers.create({
  email: "jane@example.com",
  name: "Jane Doe",
});

const intent = await stripe.paymentIntents.create({
  amount: 2000,
  currency: "usd",
  customer: customer.id,
});
```

```typescript
// After
const { data: customer } = await stripe.post("/v1/customers", {
  body: { email: "jane@example.com", name: "Jane Doe" },
});

const { data: intent, meta } = await stripe.post("/v1/payment_intents", {
  body: { amount: 2000, currency: "usd", customer: customer.id },
});

console.log(meta.requestId, meta.trace.retries);
```

## 3. Idempotency keys

The Stripe SDK accepts an `idempotencyKey` as a request option. Meridian accepts the same thing — either via `idempotencyKey` directly or as an `Idempotency-Key` header:

```typescript
// Before
await stripe.paymentIntents.create(
  { amount: 2000, currency: "usd" },
  { idempotencyKey: "order_42_attempt_1" },
);
```

```typescript
// After
await stripe.post("/v1/payment_intents", {
  body: { amount: 2000, currency: "usd" },
  idempotencyKey: "order_42_attempt_1",
});
```

## 4. Pagination

The Stripe SDK has `autoPagingEach`/`autoPagingToArray` helpers with Stripe's cursor (`starting_after`) shape. Meridian's `.paginate()` works the same way across **every** provider, not just Stripe — so the pattern you learn here also applies to Razorpay, Cashfree, etc.

```typescript
// Before
for await (const customer of stripe.customers.list({ limit: 100 })) {
  console.log(customer.id);
}
```

```typescript
// After
for await (const page of stripe.paginate("/v1/customers", { query: { limit: 100 } })) {
  const { data: customers } = page.data as { data: Array<{ id: string }> };
  for (const customer of customers) console.log(customer.id);
}
```

## 5. Error handling

The Stripe SDK throws `StripeError` subclasses (`StripeCardError`, `StripeRateLimitError`, `StripeConnectionError`, ...) distinguished by `error.type` / `error.code`. Meridian normalizes all of these into one `MeridianError`:

```typescript
// Before
try {
  await stripe.charges.create({ amount: 2000, currency: "usd", source: "tok_visa" });
} catch (err: any) {
  if (err.type === "StripeCardError") {
    // card declined — show user-facing message
  } else if (err.type === "StripeConnectionError") {
    // network issue — maybe retry
  }
  throw err;
}
```

```typescript
// After
import { MeridianError } from "meridianjs";

try {
  await stripe.post("/v1/charges", { body: { amount: 2000, currency: "usd", source: "tok_visa" } });
} catch (err) {
  if (err instanceof MeridianError) {
    console.log(err.category);   // "validation" | "rate_limit" | "network" | "auth" | "provider"
    console.log(err.retryable);  // false for a declined card, true for a transient network error
  }
  throw err;
}
```

Card declines and validation errors land in `category: "validation"` with `retryable: false` — Meridian won't retry those (correctly; retrying a decline doesn't help). Network errors and 5xx responses are `retryable: true` and are retried internally with backoff before you ever see them.

## 6. Webhooks

`stripe.webhooks.constructEvent(payload, signature, secret)` verifies the `Stripe-Signature` header and throws on failure. Meridian's `verifyWebhook` does the same verification (timing-safe HMAC-SHA256 against the `t=...,v1=...` header) but returns a boolean instead of throwing or constructing a typed event:

```typescript
// Before
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"]!, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }
  // handle event.type, event.data.object ...
  res.json({ received: true });
});
```

```typescript
// After
import { StripeAdapter } from "meridianjs";
const adapter = new StripeAdapter();

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  const isValid = adapter.verifyWebhook(req.body, req.headers["stripe-signature"] as string, secret);
  if (!isValid) return res.status(400).send("Webhook Error: invalid signature");

  const event = JSON.parse(req.body.toString("utf8"));
  // handle event.type, event.data.object ...
  res.json({ received: true });
});
```

The advantage of doing this through Meridian: the **same** `adapter.verifyWebhook(payload, signature, secret)` call shape works for Razorpay, Cashfree, Twilio, SendGrid, and every other adapter that supports webhooks — instead of looking up a different verification scheme per provider. See [Webhooks](../WEBHOOKS.md).

## 7. The actual reason to migrate: payment provider failover

The Stripe SDK only talks to Stripe. If Stripe has an incident during a checkout flow, every charge fails — full stop. Meridian lets you configure a `service("payments")` that fails over to Razorpay or Cashfree with the **same call you already wrote**:

```typescript
const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_SECRET_KEY! } },
    razorpay: { auth: { username: process.env.RZP_KEY!, password: process.env.RZP_SECRET! } },
  },
  services: {
    payments: { providers: ["stripe", "razorpay"], strategy: "failover" },
  },
});

const { data, meta } = await meridian.service("payments")!.post("/v1/charges", {
  body: { amount: 5000, currency: "inr" },
});

console.log(meta.trace.provider); // "stripe" or "razorpay" — whichever actually handled it
```

Note that request/response *shapes* still differ between Stripe and Razorpay (Meridian doesn't invent a universal charge schema) — what Meridian normalizes is the failover mechanics, error categories, retries, and observability. Plan failover request bodies accordingly, or keep provider-specific branches keyed off `meta.trace.provider`.

## What you keep from the Stripe SDK

- **Typed resource helpers, Stripe CLI, Stripe-specific betas** — Meridian wraps the REST surface generically. For very new endpoints or SDK conveniences without a Meridian equivalent yet, keep using `stripe` directly alongside `meridian.provider("stripe")`.
- **All request/response field names and the Stripe API version** behavior — unchanged.

## Checklist

- [ ] Replace `new Stripe(secretKey)` with `Meridian.create({ providers: { stripe: { auth: { apiKey: secretKey } } } })`
- [ ] Replace `stripe.<resource>.create(body)` with `meridian.provider("stripe").post("/v1/<resource>", { body })`
- [ ] Replace `autoPagingEach`/`autoPagingToArray` with `for await (const page of stripe.paginate(...))`
- [ ] Replace `instanceof StripeError` checks with `instanceof MeridianError` + `error.category`
- [ ] Replace `stripe.webhooks.constructEvent` with `adapter.verifyWebhook(payload, signature, secret)`
- [ ] Optional: add Razorpay/Cashfree and a `service("payments")` for automatic failover
