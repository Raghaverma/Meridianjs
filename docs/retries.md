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

## Retry Delay Strategy

To prevent overloading APIs (especially when recovering from outages), Meridian applies **Exponential Backoff with Full Jitter**:

$$\text{Delay} = \text{baseDelay} \times 2^{\text{retryCount}} \pm \text{Jitter}$$

This separates request times across client instances, preventing synchronized spike patterns (the thundering herd problem).

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
| `maxRetries` | `number` | `3` | Maximum retry attempts before giving up and throwing the final `MeridianError`. |
| `baseDelay` | `number` | `100` | The initial delay (in milliseconds) before the first retry. |
| `maxDelay` | `number` | `10000` | The maximum delay (in milliseconds) capped between any retries. |
| `jitter` | `boolean` | `true` | If true, adds a random jitter value (up to 50% of the delay) to stagger request execution. |
