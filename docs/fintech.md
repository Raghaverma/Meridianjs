# Meridian for Indian Fintech

**The reliability layer for Indian payment & fintech APIs.**

Razorpay, Cashfree, PayU, Juspay, PhonePe, BillDesk, CCAvenue, Setu, Decentro, and the KYC stack each ship a different SDK, a different auth scheme, a different error shape, a different retry story, and a different webhook signature format. You end up writing the same defensive plumbing — retries, idempotency, circuit breakers, rate-limit handling, webhook verification, PII redaction — once per provider, and getting it subtly wrong each time. When the thing you're moving is **money**, "subtly wrong" means a double charge, a stuck payout, or a compliance incident.

Meridian gives you **one contract** across all of them, with the reliability and compliance behaviour built into the pipeline — not left to you.

---

## Why this matters for payments specifically

| Failure mode | What usually happens | What Meridian does |
|---|---|---|
| Gateway returns 5xx *after* charging | Naive retry / failover re-charges the customer | **Never auto-replays a non-idempotent write** (POST/PATCH) across providers — the error surfaces for you to reconcile |
| Transient 429 / network blip | Lost transaction, or a retry storm | Idempotency-aware retries with exponential backoff + jitter, gated on HTTP idempotency semantics |
| One gateway degrades | Cascading failures, timeouts pile up | Per-provider circuit breaker trips and sheds load; reads fail over to a healthy gateway |
| Webhook replay / forgery | Duplicate fulfilment, fraud | Timing-safe signature verification per provider (incl. Stripe timestamp-tolerance replay protection) |
| Aadhaar / PAN / VPA in logs | DPDPA exposure | `indiaMode` redacts Aadhaar, PAN, UPI VPA, and bank-account numbers before anything is logged or recorded |

The first row is the one that matters most, and it's a **default**: Meridian will not silently re-send a charge to a second gateway, because gateway B has never seen gateway A's idempotency key. Reads (`GET`/`PUT`/`DELETE`) still fail over; writes don't.

---

## Coverage

**Payments:** Razorpay · Cashfree · PayU · Juspay · PhonePe · BillDesk · CCAvenue
**Banking / UPI:** Setu · Decentro
**KYC / identity:** HyperVerge · Digio · Karza · IDfy
**Tax & financial data:** ClearTax · Perfios

Every one of these passes the *same* conformance contract (see [Trust signals](#trust-signals)).

---

## Quick start

```ts
import { Meridian, IdempotencyLevel } from "meridianjs";

const meridian = await Meridian.create({
  providers: {
    razorpay: {
      auth: { username: process.env.RAZORPAY_KEY_ID!, password: process.env.RAZORPAY_KEY_SECRET! },
    },
    cashfree: {
      auth: {
        custom: {
          clientId: process.env.CASHFREE_CLIENT_ID!,
          clientSecret: process.env.CASHFREE_CLIENT_SECRET!,
        },
      },
    },
  },
  // DPDPA-aware redaction: Aadhaar / PAN / UPI VPA / bank account are stripped
  // from logs, metrics, and recordings.
  compliance: { indiaMode: true, piiRedaction: true },
  // Auto-attach idempotency keys so safe retries never double-execute.
  idempotency: { defaultLevel: IdempotencyLevel.CONDITIONAL, autoGenerateKeys: true },
});

const razorpay = meridian.provider("razorpay")!;
const order = await razorpay.post("/v1/orders", {
  body: { amount: 50000, currency: "INR", receipt: "rcpt_001" },
});

console.log(order.meta.trace);
// { retries, latency, circuitBreaker: "CLOSED", rateLimitRemaining }
```

Every response is normalized: `response.data` is the provider payload, `response.meta` carries the request id, rate-limit state, and a reliability `trace`. Every error is a `MeridianError` with a stable `category` (`auth` | `rate_limit` | `network` | `provider` | `validation`) and `code` — the same across all 15 providers.

## Safe multi-gateway failover

```ts
const meridian = await Meridian.create({
  providers: { razorpay: { /* … */ }, cashfree: { /* … */ } },
  services: {
    payments: { providers: ["razorpay", "cashfree"], strategy: "failover" },
  },
});

const payments = meridian.service("payments")!;

// A read fails over to Cashfree if Razorpay is down…
const status = await payments.get("/v1/payments/pay_123");

// …a charge does NOT. If Razorpay errors mid-write, you get the error — not a
// duplicate charge on Cashfree.
await payments.post("/v1/orders", { body: { amount: 50000, currency: "INR" } });
```

## UPI helpers

```ts
import { createUpiDeepLink, validateVpa } from "meridianjs";

validateVpa("merchant@okhdfcbank"); // true

const link = createUpiDeepLink({
  vpa: "merchant@okhdfcbank",
  payeeName: "Acme Retail",
  amount: 1499,                 // ₹1499.00
  note: "Order #1001",
  transactionRef: "TXN20260619",
});
// upi://pay?pa=merchant%40okhdfcbank&cu=INR&pn=Acme%20Retail&am=1499.00&...
```

## Webhook verification

```ts
import { RazorpayAdapter, WebhookVerifier } from "meridianjs";

// Timing-safe; throws/false on tamper. (Stripe webhooks additionally enforce a
// timestamp tolerance to block replays.)
const valid = WebhookVerifier.verify(
  new RazorpayAdapter(),
  rawRequestBody,                       // the exact bytes, unparsed
  request.headers["x-razorpay-signature"],
  process.env.RAZORPAY_WEBHOOK_SECRET!,
);
if (!valid) return res.status(400).end();
```

## Multi-step flows that roll back

```ts
import { runTransaction } from "meridianjs";

// Create an order, then a payout — if the payout fails, the order is compensated.
const result = await runTransaction([
  { name: "order", execute: () => razorpay.post("/v1/orders", { body: order }),
    rollback: (r) => razorpay.post(`/v1/orders/${r.data.id}/cancel`) },
  { name: "payout", execute: () => razorpay.post("/v1/payouts", { body: payout }) },
]);
```

---

## Trust signals

Reliability claims are worth nothing unverified. Meridian backs them three ways:

1. **One conformance contract, every provider.** A single battery in [`src/testing/contract.ts`](../src/testing/contract.ts) is run against *every* built-in adapter ([`src/providers/contract.test.ts`](../src/providers/contract.test.ts)): URL/request shaping, auth rejection, error→category mapping with correct retryability, rate-limit parsing, pagination, normalization, idempotency config. A provider is only "supported" if it upholds the identical contract — no adapter is special-cased.

2. **Property-tested reliability core.** Retry, circuit breaker, rate limiter, and failover are checked with seeded, reproducible property tests over hundreds of randomized scenarios ([`src/strategies/reliability.property.test.ts`](../src/strategies/reliability.property.test.ts), [`src/services/failover.property.test.ts`](../src/services/failover.property.test.ts)). The headline invariant — *a non-idempotent write is never replayed on a second provider* — is proven across 400 random topologies per router, not one hand-picked test.

3. **Live sandbox tests.** Opt-in end-to-end tests run the full pipeline against real provider sandboxes (Razorpay test mode as the flagship) — [`src/live/integration.test.ts`](../src/live/integration.test.ts). Unit tests stub `fetch`; these don't.

```bash
MERIDIAN_LIVE_TESTS=1 RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx \
  npx vitest run src/live
```

Backed by 2,000+ tests in CI with coverage ratchets that can only go up.

---

## What you stop writing

Retry loops. Idempotency-key bookkeeping. Circuit breakers. Rate-limit header parsing per vendor. Webhook HMAC comparisons (timing-safe, per provider). PII scrubbing before logging. Error-shape normalization across five different JSON conventions. Failover that doesn't double-charge.

You write your payment logic once, against one contract, and let the layer underneath be boringly reliable.
