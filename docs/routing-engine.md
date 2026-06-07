# Routing Engine — Internals

How Meridian decides which provider handles each request.

---

## The two routing layers

Routing happens at two independent levels:

| Layer | Class | When it runs |
|---|---|---|
| **Service routing** | `ServiceClient` | `meridian.service("llm").get(…)` — selects and failovers across providers |
| **Provider pipeline** | `RequestPipeline` | per provider — rate limiter → circuit breaker → retry |

The service layer picks the provider; the pipeline layer executes the call and handles per-provider resilience. They compose: if the pipeline throws a retryable `MeridianError`, the service layer can failover to the next provider.

---

## Strategy selection: `selectIndex()`

`ServiceClient.selectIndex()` is called once per request to choose the primary provider index. Each strategy uses different data:

### `failover`
Always returns index `0` — the first provider in the list. No selection logic; all intelligence lives in `failoverOrder()`.

### `round-robin`
Increments a shared counter modulo provider count:

```typescript
const idx = this.roundRobinIndex % this.providers.length;
this.roundRobinIndex++;
```

Stateful but non-atomic — fine for in-process use. For distributed deployments use `StateStorage` so the counter persists across instances.

### `lowest-latency`
Returns the index with the smallest value in `this.latencyMs[]`. Latency is tracked per provider using an **Exponential Weighted Moving Average (EWMA)**:

```typescript
this.latencyMs[idx] = 0.3 * latency + 0.7 * current;
```

Weight 0.3 means the most recent call contributes 30% of the estimate. Cold providers start at 0 ms and are therefore preferred on first call — effectively a weighted round-robin until enough samples accumulate. After ~10 calls the estimate stabilises.

### `cheapest`
Returns the index whose provider name maps to the smallest value in `config.costs`. If a provider is not in the costs map it is treated as infinitely expensive and never selected unless all others are also missing costs.

### `highest-success-rate`
Calls `getStats()` (wired to `AnalyticsCollector`) and parses `successRate` as a float. Falls back to `"100"` for unknown providers so new providers are preferred (optimistic).

### `weighted`
Samples from a probability distribution:

```typescript
let rand = Math.random() * totalWeight;
for (let i = 0; i < providers.length; i++) {
  rand -= weights[providers[i]] ?? 1;
  if (rand <= 0) return i;
}
```

Providers without explicit weights receive weight `1`. If all providers have equal weight this degenerates to uniform random selection — slightly biased compared to round-robin for small n but converges over time.

### `geo`
Reads `process.env.MERIDIAN_REGION ?? config.defaultRegion`, looks up the first provider name in `config.regions[region]`, and returns its index. Falls back to index `0` if the region is unmapped or the environment variable is unset.

---

## Failover ordering: `failoverOrder()`

When the primary provider throws a `MeridianError` whose `category` is in `failoverOn` (default: `["rate_limit", "network", "provider"]`), `ServiceClient.route()` iterates through the failover order:

```typescript
for (const idx of this.failoverOrder()) {
  try {
    return await this.providers[idx].method(endpoint, options);
  } catch (err) {
    if (err instanceof MeridianError && this.failoverOn.has(err.category)) continue;
    throw err; // non-retryable: surface immediately
  }
}
throw lastError ?? allFailedError;
```

The order depends on strategy:

| Strategy | Failover order |
|---|---|
| `failover` | declaration order (index 0 → 1 → 2 …) |
| `round-robin` | declaration order |
| `lowest-latency` | sorted by ascending EWMA latency |
| `cheapest` | sorted by ascending declared cost |
| `highest-success-rate` | sorted by descending `successRate` from `AnalyticsCollector` |
| `weighted` | sorted by descending declared weight |
| `geo` | region-preferred providers first, then the rest |

**Non-failover errors** (e.g. `category: "validation"`, `category: "auth"`) are not caught — they surface immediately regardless of failover config. Only errors whose category matches `failoverOn` trigger routing to the next provider.

---

## Latency tracking: `updateLatency()`

Called after every successful response, latency is read from `result.meta.trace.latency` (set by `RequestPipeline.execute()` as `Date.now() - startTime`):

```typescript
private updateLatency(idx: number, latency: number | undefined): void {
  if (latency === undefined) return;
  const current = this.latencyMs[idx]!;
  this.latencyMs[idx] = current === 0 ? latency : 0.3 * latency + 0.7 * current;
}
```

Latency is **not** updated on failure — a failed call neither improves nor penalises the estimate. This means a provider that suddenly starts timing out stays at its last good latency until it starts succeeding again, which is usually the right behaviour.

---

## Mixed strategies

Different services can use different strategies in the same Meridian instance:

```typescript
services: {
  llm:        { providers: ["openai", "anthropic"], strategy: "failover" },
  embeddings: { providers: ["cohere", "openai"],    strategy: "cheapest", costs: { cohere: 0.00004, openai: 0.0001 } },
  payments:   { providers: ["stripe", "razorpay"],  strategy: "weighted", weights: { stripe: 70, razorpay: 30 } },
}
```

Each `ServiceClient` instance is independent. They do not share latency state, weights, or counters.

---

## What the service layer does not do

- **Circuit breaking** — handled per-provider in `RequestPipeline`, not in `ServiceClient`. A circuit that is `OPEN` throws `CircuitOpenError` (a `MeridianError` with category `"provider"`), which the service layer treats as a failover trigger.
- **Retries** — handled per-provider in `RequestPipeline`. The service layer sees the final outcome after all retries have been exhausted.
- **Rate limiting** — per-provider token bucket in `RateLimiter`. The service layer never waits for rate limits; it routes around them if the error category is in `failoverOn`.

This separation means each feature has one responsibility and can be configured independently.

---

## See also

- [Failover & routing strategies](failover/index.md) — configuration reference
- [Circuit breaker](circuit-breaker.md) — per-provider failure detection
- [Automatic retries](retries.md) — per-provider retry logic
