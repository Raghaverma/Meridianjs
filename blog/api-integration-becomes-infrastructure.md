# Why Every API Integration Eventually Becomes Infrastructure

It starts simple. You add `stripe` to your `package.json`, call `stripe.charges.create()`, and ship in a day.

Six months later, you have:

- A retry wrapper around every Stripe call because of the `429`s you hit in production.
- A circuit breaker you wrote in a weekend after Stripe's November outage cost you $40k in abandoned carts.
- A normalisation layer because you added Razorpay for India and their response shape is different.
- A schema validator because Stripe renamed a field and your DB started getting `undefined` values.
- An observability adapter because you couldn't see which of your 7 providers was causing the spike in p95.
- A policy layer because legal told you to stop sending customer emails to OpenAI.

You didn't plan to build a reliability platform. You planned to take payments. The platform accumulated, call by call, incident by incident.

This is what happens to every team that integrates third-party APIs at scale. Here's why — and what to do about it.

---

## The stages of API integration maturity

### Stage 1: Direct calls

```typescript
const charge = await stripe.charges.create({ amount: 2000, currency: "usd" });
```

Fast to write. No overhead. Breaks immediately when Stripe returns a 429 or goes down.

**Triggers the next stage:** first production 429.

### Stage 2: Manual error handling

```typescript
async function createCharge(amount: number) {
  try {
    return await stripe.charges.create({ amount, currency: "usd" });
  } catch (err) {
    if (err.statusCode === 429) {
      await sleep(1000);
      return await stripe.charges.create({ amount, currency: "usd" });
    }
    throw err;
  }
}
```

Handles the immediate case. Duplicated across every endpoint. No exponential backoff. No jitter (thundering herd). No maximum retry count.

**Triggers the next stage:** first timeout during a Stripe outage.

### Stage 3: Generic retry wrapper

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await sleep(Math.pow(2, i) * 1000 + Math.random() * 1000);
    }
  }
  throw new Error("Unreachable");
}
```

Better. Still retries on every error, including non-retryable ones. You're double-charging customers on 500 errors.

**Triggers the next stage:** first double-charge incident.

### Stage 4: Idempotency + error classification

Now you need to know which errors are retryable. Different per provider. You write a classifier for Stripe. Then a different one for Razorpay. Then for OpenAI.

**Triggers the next stage:** first total provider outage lasting > 1 minute.

### Stage 5: Circuit breaker

You write one. It doesn't have distributed state, so each Lambda instance has its own failure count. You fix that with Redis. Now you have a dependency on Redis uptime for payment processing.

**Triggers the next stage:** you add a second payment provider for backup.

### Stage 6: Routing and failover

Two providers. Different response shapes. You write a normalisation layer. Now when you add a third provider you have to update the normalisation layer, the retry classifier, the circuit breaker config, and the routing logic.

**Triggers the next stage:** legal audit.

### Stage 7: Policy engine

Legal wants PII blocked from OpenAI. Compliance wants an audit log. You add middleware. It runs before some calls but not others because the codebase has grown organically and there's no single request path.

---

## The pattern: reliability as infrastructure

Every team above Stage 2 is building the same thing: a reliability layer that sits between the application and third-party APIs. They're just building it ad hoc, one incident at a time.

The components are always the same:

| Component | What it does | When you need it |
|---|---|---|
| Retry + backoff | handles transient failures | day 1 |
| Error normalisation | consistent error format across providers | day 1 |
| Circuit breaker | stops hammering dead upstreams | first outage |
| Failover routing | routes around dead providers | first multi-provider setup |
| Idempotency | safe retries on write operations | first double-charge |
| Rate limiting | respects provider limits | first 429 |
| Schema drift detection | catches silent API changes | first undefined-in-DB |
| Policy engine | governance rules on every call | first compliance request |
| Observability | per-provider metrics and traces | first opaque incident |

The question isn't whether you'll build this. The question is whether you build it intentionally or whether you assemble it from incidents.

---

## What intentional reliability infrastructure looks like

```typescript
import { Meridian, blockPII, RedisStateStorage } from "meridianjs";

const meridian = await Meridian.create({
  // Distributed state: circuit breaker shared across all instances
  mode: "distributed",
  stateStorage: new RedisStateStorage(redis),

  providers: {
    stripe:    { auth: { apiKey: process.env.STRIPE_KEY },    retry: { maxRetries: 3, jitter: true }, circuitBreaker: { failureThreshold: 5, timeout: 30_000 } },
    razorpay:  { auth: { keyId: process.env.RAZORPAY_ID },    retry: { maxRetries: 3, jitter: true }, circuitBreaker: { failureThreshold: 5, timeout: 30_000 } },
    openai:    { auth: { apiKey: process.env.OPENAI_KEY },    retry: { maxRetries: 2, jitter: true }, circuitBreaker: { failureThreshold: 3, timeout: 60_000 } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_KEY }, retry: { maxRetries: 2, jitter: true }, circuitBreaker: { failureThreshold: 3, timeout: 60_000 } },
    sendgrid:  { auth: { apiKey: process.env.SENDGRID_KEY },  retry: { maxRetries: 4, jitter: true }, circuitBreaker: { failureThreshold: 5, timeout: 30_000 } },
  },

  services: {
    payments: { providers: ["stripe", "razorpay"], strategy: "failover",       failoverOn: ["provider", "network"] },
    llm:      { providers: ["openai", "anthropic"],  strategy: "lowest-latency"                                     },
    email:    { providers: ["sendgrid"],             strategy: "failover"                                           },
  },

  // Governance: runs before every request to every provider
  policies: [
    blockPII(["openai", "anthropic"]),           // no PII to AI providers
    requireFields(["tenantId"]),                 // audit trail
    denyCountries(["KP", "IR", "CU"]),          // sanctions compliance
  ],

  // Observability: every request, every provider, normalised
  observability: new DatadogObservability(datadogClient),
});
```

This is declared once. Every provider gets the same retry behaviour, the same error format, the same circuit breaker, the same policy enforcement, the same traces. Adding a new provider is one object in `providers`.

---

## The shift in how you think about providers

The key change is moving from `provider.stripe.createCharge()` to `service.payments.post("/v1/charges")`.

Your application doesn't know which payment processor handled the request. It sees a `NormalizedResponse` with `meta.provider`, `meta.trace`, and `meta.rateLimit` — same shape, regardless of vendor. The service abstraction makes the provider an implementation detail.

This has a downstream effect on your architecture:

- **New providers are 1-line changes** to the `services` config, not rewrites of the integration layer.
- **Provider contracts live in adapters**, not scattered across your application code.
- **Governance is centralised** — one policy block in the SDK config, not middleware that may or may not run depending on which code path called the provider.
- **Observability is automatic** — `meta.trace` tells you retries, latency, circuit breaker state, and provider name on every response.

---

## When to think about this

If you have more than 3 third-party API integrations and you've been through at least one outage or rate-limit incident, your integration code is already on its way to becoming infrastructure. The question is whether you get ahead of it.

The components listed above are not optional in production. You will build them eventually. Building them intentionally, as a layer rather than scattered across your codebase, is the difference between infrastructure you control and infrastructure that controls you.

---

## See also

- [Reliability Lab](../examples/reliability-lab/index.ts) — 5-phase outage simulation
- [Routing Engine internals](../docs/routing-engine.md)
- [Policy Engine internals](../docs/policy-engine.md)
- [Circuit Breaker internals](../docs/circuit-breaker.md)
- [Benchmark results](../benchmarks/RESULTS.md) — +0.10 ms overhead; all reliability checks pass

```bash
npm install meridianjs
```
