# Automatic Retries

Transient errors (like network timeouts or temporary server outages) and rate-limiting blocks should not crash your application. Meridian embeds a sophisticated retry pipeline wrapping every API call.

---

## Under What Conditions Does Meridian Retry?

Meridian retries requests automatically when:
1. **Network Failures**: Generic connection loss, socket resets (`ECONNRESET`), DNS issues (`ENOTFOUND`), and protocol aborts.
2. **Timeouts**: When an API request times out before receiving a response.
3. **Upstream Server Errors**: Standard HTTP `500`, `502`, `503`, and `504` status codes indicating transient vendor outages.
4. **Rate Limits**: Standard HTTP `429` status codes (if the error is marked retryable, i.e., not a quota exhaustion).

The mapping is driven by the provider adapter's `parseError` method returning `retryable: true`.

---

## 429 Is Not One Signal

A `429` status code does not mean one thing. Meridian does not run a single global rule for "status 429 → retry." Classification is **adapter-defined**: each provider's `parseError` decides the `category`, `retryable`, and (optionally) `retryAfter` for its own `429`s, based on how that specific provider actually uses the status code. A few real examples from the built-in adapters:

- **Stripe** ([`src/providers/stripe/adapter.ts`](../src/providers/stripe/adapter.ts)) — every `429` is `rate_limit` and `retryable: true`. Stripe's `Retry-After` is meaningful, so it's parsed and attached to the error as `retryAfter`.
- **OpenAI** ([`src/providers/openai/adapter.ts`](../src/providers/openai/adapter.ts)) — `429` is `rate_limit`, but `retryable` is `false` when the error body's `code` is `insufficient_quota`. That's a billing wall, not a transient throttle — retrying it just burns attempts on a request that can never succeed until the account is topped up.
- **GitHub** ([`src/providers/github/adapter.ts`](../src/providers/github/adapter.ts)) — GitHub's *secondary* rate limit is signaled as `403` with an `X-RateLimit-Remaining: 0` header, not `429` at all. The adapter still classifies it as `category: "rate_limit"`, `retryable: true`, because the signal matters more than the status code that carried it.
- **Anthropic** ([`src/providers/anthropic/adapter.ts`](../src/providers/anthropic/adapter.ts)) — capacity/overload conditions use a distinct `529` status, kept under `category: "provider"` rather than `rate_limit`, since it's a capacity signal rather than a quota one (and carries no `Retry-After`).

Every adapter exposes the same shape (`category`, `retryable`, `retryAfter`) to the rest of the pipeline, so the retry loop, rate limiter, and circuit breaker never special-case a provider — but what goes *into* that shape is entirely up to the adapter. See [Adapters: Error Mapping](./adapters.md) and run `npm run test:contracts` to verify a custom adapter's classification holds to the same invariants.

---

## Retry Delay Strategy

To prevent overloading APIs (especially when recovering from outages), Meridian applies **Exponential Backoff with Full Jitter**:

$$\text{Delay} = \text{baseDelay} \times 2^{\text{retryCount}} \pm \text{Jitter}$$

This separates request times across client instances, preventing synchronized spike patterns (the thundering herd problem).

**Note:** this delay is computed purely from the attempt number — it does not read the adapter's parsed `retryAfter`, even when the provider supplied a meaningful `Retry-After` header. The parsed `retryAfter` is consumed elsewhere in the pipeline: it pushes back the shared per-provider token bucket in the [rate limiter](./rate-limits.md#how-throttling-works), so a `Retry-After: 60` from Stripe immediately throttles *every* caller sharing that provider's rate limiter — not just the one that got the `429`. It does not, however, affect the [circuit breaker](./circuit-breaker.md#configuration)'s cooldown, which runs on its own fixed `timeout` regardless of what the provider's `Retry-After` said.

---

## Configuration

You can customize retry configurations globally or override them per provider.

```typescript
const meridian = await Meridian.create({
  providers: {
    stripe: {
      auth: { apiKey: "sk_key" },
      // Custom overrides for Stripe
      retry: {
        maxRetries: 5,        // Retry up to 5 times
        baseDelay: 200,       // Start with 200ms delay
        maxDelay: 5000,       // Cap delay at 5000ms
        jitter: true          // Apply random jitter
      }
    }
  },
  defaults: {
    // Default retry settings for all other providers
    retry: {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 10000,
      jitter: true
    }
  },
  localUnsafe: true
});
```

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxRetries` | `number` | `0` | Maximum retry attempts before giving up and throwing the final `MeridianError`. Defaults to **no retries** — a deliberate safety-first default, since retrying isn't always safe without a proven-idempotent operation. Set this explicitly to enable retries. |
| `baseDelay` | `number` | `1000` | The initial delay (in milliseconds) before the first retry. |
| `maxDelay` | `number` | `30000` | The maximum delay (in milliseconds) capped between any retries. |
| `jitter` | `boolean` | `true` | If true, adds a random jitter value (up to 50% of the delay) to stagger request execution. |

Even with `maxRetries` configured, a retry only happens when **both** are true: the adapter marked the error `retryable: true`, and the idempotency level is proven (`SAFE`/`IDEMPOTENT`, or `CONDITIONAL` with an idempotency key supplied). See [Adapters](./adapters.md) for `getIdempotencyConfig()`.
