# Adding Circuit Breakers to Third-Party APIs in TypeScript

Your app is only as reliable as the slowest API it calls.

When Stripe is down, every payment request waits for a timeout. When OpenAI is rate-limiting, every AI request queues. The downstream effect: your own API slows down, your users see errors, and the problem is opaque because the stack trace points at *your* code, not the vendor.

Circuit breakers are the standard fix. Here's how to add them to any TypeScript project.

---

## What a circuit breaker does

The classic metaphor: your house's circuit breaker doesn't let electricity flow through a broken wire. It trips, cuts the current, and you reset it once the problem is fixed.

An API circuit breaker works the same way:

1. **CLOSED** — normal state. Requests flow through. Failures are counted.
2. **OPEN** — too many failures. Requests fail immediately without touching the upstream. Error budget is preserved. Downstream load is shed.
3. **HALF-OPEN** — after a timeout, probe with a few requests. If they succeed, close. If they fail, open again.

```
   CLOSED ──── (5 failures) ────→ OPEN
      ↑                              │
      └── (2 probes succeed) ─── HALF-OPEN ←── (timeout)
```

The key benefit: **fail-fast**. Instead of waiting 5 seconds for Stripe's timeout, you fail in < 1 millisecond. Your users see an error immediately. Your API stays responsive.

---

## The naive implementation

A minimal circuit breaker in TypeScript:

```typescript
class CircuitBreaker {
  private failures = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private nextAttempt = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (Date.now() < this.nextAttempt) throw new Error("Circuit open");
      this.state = "HALF_OPEN";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
  }

  private onFailure() {
    this.failures++;
    if (this.failures >= 5) {
      this.state = "OPEN";
      this.nextAttempt = Date.now() + 30_000;
    }
  }
}

const stripeBreaker = new CircuitBreaker();

// Wrap every Stripe call
const charge = await stripeBreaker.execute(() =>
  stripe.charges.create({ amount: 2000, currency: "usd", source: "tok_visa" })
);
```

This works but has problems:

- **No rolling window** — 5 failures on Monday shouldn't hold the circuit open on Tuesday.
- **All errors are equal** — a 400 validation error shouldn't count the same as a 503 outage.
- **No distributed state** — in a multi-instance deployment, each instance has its own failure count. Instance A could be tripping while instance B keeps sending traffic.
- **No metrics** — you can't see how many calls the breaker saved.
- **One per provider** — with 5 providers you're writing 5 breakers and wiring them yourself.

---

## A production-ready implementation

Meridian wraps every provider call in a circuit breaker automatically:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: {
      auth: { apiKey: process.env.STRIPE_KEY },
      circuitBreaker: {
        failureThreshold: 5,              // consecutive failures before opening
        timeout: 30_000,                  // ms to wait before HALF_OPEN probe
        volumeThreshold: 10,              // min requests before % check activates
        rollingWindowMs: 60_000,          // 1-minute rolling window
        errorThresholdPercentage: 50,     // open if 50%+ of calls fail in window
      },
    },
    openai: {
      auth: { apiKey: process.env.OPENAI_KEY },
      circuitBreaker: {
        failureThreshold: 3,              // AI endpoints: more sensitive
        timeout: 60_000,
        volumeThreshold: 5,
        rollingWindowMs: 30_000,
        errorThresholdPercentage: 40,
      },
    },
  },
});
```

Every `provider.get()` / `.post()` call flows through the circuit breaker. You don't wrap anything.

---

## The two-trigger algorithm

Meridian's breaker has two independent opening triggers:

**Trigger 1 — Consecutive failure count**

Opens immediately when `failureThreshold` consecutive failures accumulate. Catches hard outages fast, regardless of traffic volume.

**Trigger 2 — Rolling window error rate**

Only activates when at least `volumeThreshold` requests have run in the window. If 6 of the last 10 requests failed (60% > 50% threshold), the circuit opens. This catches degraded providers that aren't fully down — the kind that pass health checks but fail 60% of real requests.

Both triggers are evaluated on every failure. Either one is sufficient to open the circuit.

---

## Reading circuit state

```typescript
const status = meridian.getCircuitStatus("stripe");
// {
//   state: "OPEN",
//   failures: 7,
//   successes: 0,
//   lastFailure: Date,
//   nextAttempt: Date,  // when HALF_OPEN will be tried
// }

const health = meridian.health();
// { stripe: { status: "down", circuitBreaker: "OPEN", successRate: "28.6%" } }
```

Use `health()` in your readiness probe. If a critical provider's circuit is `OPEN`, return 503 — don't pretend you're healthy when you're dropping 70% of payment requests.

---

## Distributed state

In-memory state resets on every Lambda cold start and is not shared between instances. In a distributed deployment, you want shared state:

```typescript
import { Meridian, RedisStateStorage } from "meridianjs";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const meridian = await Meridian.create({
  localUnsafe: true,
  mode: "distributed",
  stateStorage: new RedisStateStorage(redis),
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_KEY }, circuitBreaker: { failureThreshold: 5, timeout: 30_000 } },
  },
});
```

All instances share the same circuit state. When one instance observes 5 failures, all instances stop sending traffic to Stripe.

---

## Circuit breakers + failover

A circuit breaker alone protects your app from a slow upstream. Combined with failover, it routes around it:

```typescript
services: {
  payments: {
    providers: ["stripe", "razorpay"],
    strategy: "failover",
    failoverOn: ["provider", "network"],  // not rate_limit — that we retry
  },
}
```

When the Stripe circuit opens, the `payments` service routes to Razorpay immediately — no timeout, no waiting for a probe. When the circuit closes, traffic returns to Stripe.

---

## What you should monitor

- **Circuit state transitions** — every CLOSED→OPEN event is an incident. Page on it.
- **Fail-fast rate** — requests blocked by an open circuit. High rate means a provider has been down for a while.
- **Half-open probe results** — recovery signals. Consecutive successes mean the provider is back.

```typescript
meridian.analytics()
// { stripe: { requests: 1200, errorRate: "4.2%", avgLatency: 240, p95Latency: 480 } }
```

---

## See also

- [Circuit breaker internals](../docs/circuit-breaker.md) — the two-trigger algorithm, HALF_OPEN state machine, fail-fast savings
- [Reliability Lab](../examples/reliability-lab/index.ts) — watch the breaker trip and recover live

```bash
npm install meridianjs
npx vite-node examples/reliability-lab/index.ts
```
