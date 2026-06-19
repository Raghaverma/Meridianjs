# Circuit Breaker

When an upstream provider (e.g. Stripe, twilio) suffers an extended outage, repeatedly firing requests will slow down your application, waste resources, and delay error responses. 

Meridian builds a **Circuit Breaker** directly into the `RequestPipeline` for every provider.

---

## How It Works

The circuit breaker has three states:
1. **Closed**: Normal state. All requests are sent to the provider. If requests fail, failure counts are tracked.
2. **Open**: If failures cross the threshold inside a rolling window, the circuit opens. All subsequent requests fail fast immediately, throwing a `MeridianError` with category `"provider"` and message `"Circuit breaker is open"`, avoiding network calls entirely.
3. **Half-Open**: After a cooldown timeout, the circuit enters half-open mode. A limited number of trial requests are sent. If they succeed, the circuit closes. If any fail, it re-opens.

```
       +-------------------------+
       |                         |
       v                         | (Outage Continues / Trial Fails)
  +----------+  Threshold Crossed |  +----------+
  |  CLOSED  |------------------->|   OPEN   |
  +----------+                    +----------+
       ^                               |
       |                               | (Cooldown Expired)
       |       +-------------+         |
       +-------|  HALF-OPEN  |<--------+
 (Trial Succeeds) +-------------+
```

---

## The two-trigger algorithm

`ProviderCircuitBreaker.shouldOpenCircuit()` has two independent triggers — either is sufficient to open the circuit:

**Trigger 1 — Consecutive failure count**

```typescript
if (this.failures >= this.config.failureThreshold) return true;
```

Opens the circuit as soon as `failureThreshold` consecutive failures accumulate, regardless of total request volume. Useful for catching hard outages fast.

**Trigger 2 — Rolling window error rate**

```typescript
const windowStart = Date.now() - this.config.rollingWindowMs;
const recentInWindow = this.recentResults.filter(r => r.timestamp >= windowStart);
if (recentInWindow.length < this.config.volumeThreshold) return false; // not enough data
const errorRate = failuresInWindow / recentInWindow.length * 100;
return errorRate >= this.config.errorThresholdPercentage;
```

Requires at least `volumeThreshold` requests in the window before the percentage check activates. This prevents a single failure on a cold provider from tripping the circuit.

A **success** in the `CLOSED` state resets the consecutive failure counter to zero, but does not remove past failures from the rolling window. A provider that alternates success/failure can still trip via the error-rate trigger.

## HALF_OPEN state machine

When the cooldown expires (`Date.now() >= nextAttempt`), the next call transitions to `HALF_OPEN`. In this state:

- Successes increment `this.successes`. Once `successThreshold` successes accumulate, the circuit closes and `failures` resets.
- Any failure immediately reopens the circuit and sets a new `nextAttempt`.

`OPEN` itself fails every caller fast and in sync — `state` and `nextAttempt` live on one `ProviderCircuitBreaker` instance per provider, so every caller hitting a tripped circuit sees the same `nextAttempt` and rejects immediately without a network call. But the transition out of `OPEN` is not currently gated: as soon as `nextAttempt` passes, **every** caller in flight at that moment flips the breaker to `HALF_OPEN` and sends its own trial request — there's no lock limiting it to a single probe. If several callers are queued up when a long-tripped provider's cooldown expires, they will all dispatch trial requests at once. See [Retry-After and Shared Cooldowns](#retry-after-and-shared-cooldowns) below.

## Position in the pipeline

The circuit breaker wraps the innermost `fetch()` call, inside the retry loop:

```
rateLimiter.acquire()
  └─ retryStrategy.execute(
       └─ circuitBreaker.execute(
            └─ fetch(builtRequest.url)
         )
     )
```

This means:
- A circuit-open error **is counted as a retry attempt** if `maxRetries > 0` and the error is somehow retryable (it is not by default — `CircuitOpenError` has `retryable: false`).
- The circuit breaker's failure count increases on **every** failed attempt, including retried ones. A retry loop that attempts 3 times on a dead provider will record 3 failures.
- The service-layer failover sees the final `MeridianError` after all retries have been exhausted. If the circuit is `OPEN`, the error reaches the service layer after the first attempt (no retries), so failover is faster for a tripped circuit than for a slow timeout.

## Fail-fast savings

When the circuit is `OPEN`, `execute()` throws `CircuitOpenError` synchronously before calling `fetch()`. The benchmark shows this takes **< 1 ms** compared to the real upstream round-trip (25–500 ms for real network calls). For a provider that is down for 60 seconds with 1000 req/s of traffic, a closed circuit wastes ~60 000 network calls; an open circuit wastes 5 (the failures that tripped it) plus probe calls during recovery.

---

## Configuration

You can configure circuit breaker parameters globally or override them per provider.

```typescript
const meridian = await Meridian.create({
  providers: {
    github: {
      auth: { token: "gh_token" },
      circuitBreaker: {
        failureThreshold: 5,        // Open after 5 consecutive failures
        timeout: 30000,             // Wait 30 seconds before half-open state
        volumeThreshold: 10,        // Minimum 10 requests required in rolling window
        rollingWindowMs: 10000,     // Window size of 10 seconds
        errorThresholdPercentage: 50 // Open if 50%+ of requests in window fail
      }
    }
  },
  localUnsafe: true
});
```

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `failureThreshold` | `number` | `5` | Trigger opening the circuit after this many consecutive errors. |
| `timeout` | `number` | `10000` | Cooldown duration (in milliseconds) the circuit remains open before transitioning to half-open. |
| `volumeThreshold` | `number` | `10` | The minimum number of requests in the window before percentage-based checks run. |
| `rollingWindowMs` | `number` | `60000` | The rolling time window (in milliseconds) to calculate stats over. |
| `errorThresholdPercentage`| `number` | `50` | Open the circuit if the failure rate in the window exceeds this percentage. |

---

## Retry-After and Shared Cooldowns

`timeout` (the breaker's cooldown) is a fixed, configured duration — it is **not** derived from any upstream `Retry-After` value. A provider returning `Retry-After: 60` doesn't make the breaker wait 60 seconds; it waits whatever `timeout` is set to, regardless of what the provider asked for. The parsed `retryAfter` is used elsewhere (the [rate limiter's token bucket](./rate-limits.md)), not here. See [429 Is Not One Signal](./retries.md#429-is-not-one-signal) for how that classification flows through the pipeline.

What *is* shared across callers today is the breaker's `OPEN` state itself — one breaker instance per provider means every caller fails fast against the same `nextAttempt`, so you don't get N callers each independently hammering a known-down provider. What is **not** yet coordinated is re-entry: as noted above, nothing currently staggers or rate-limits the trial requests once the cooldown expires, so recovery can itself produce a burst against a provider that just came back up. Today, backoff between an individual caller's own retry attempts is jittered per-caller (see [Retry Delay Strategy](./retries.md#retry-delay-strategy)) rather than coordinated across callers at the adapter level.

An adapter-level shared cooldown with staggered re-entry (e.g. one designated probe per recovery window, others waiting on its result) is on the roadmap but not implemented yet.

---

## Persistence in Production (StateStorage)

By default, the circuit breaker state is kept in-memory. However, in serverless or multi-instance containerized deployments, local in-memory state leads to "cold-start resets" and uncoordinated status syncs.

For production, you should pass a shared storage implementation (like Redis or Upstash) using the `StateStorage` interface:

```typescript
import { Meridian, RedisStateStorage } from "meridianjs";
import { createClient } from "redis";

const redisClient = createClient({ url: "redis://localhost:6379" });
await redisClient.connect();

const meridian = await Meridian.create({
  providers: {
    stripe: { auth: { apiKey: "sk_key" } }
  },
  mode: "distributed",               // Enable distributed state mode
  stateStorage: new RedisStateStorage(redisClient) // Share state breaker across instances!
});
```
