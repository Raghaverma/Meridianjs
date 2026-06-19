# Client-Side Rate Limiting

To prevent requests from being rejected by third-party APIs with `429 Too Many Requests`, Meridian implements smart client-side throttling. It tracks rate limits and automatically staggers requests before a threshold is breached.

---

## How Throttling Works

1. **Header Inspection**: Every API response is parsed by the provider's adapter to extract rate limit metadata (e.g. `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`).
2. **Local Token Bucket**: Meridian uses a Token Bucket rate limiter initialized with provider limits.
3. **Adaptive Backoff**: When remaining capacity drops below **20%** (utilization > 80%), Meridian automatically reduces the allowed request rate by **50%** to avoid hitting hard limits. As utilization drops back below 80%, the rate gradually recovers toward the baseline, preventing permanent throttling.
4. **Queue & Stagger**: When the local bucket runs out of tokens, subsequent requests are delayed and queued rather than thrown. If the queue size exceeds the limit, it throws a rate limit queue error.

---

## Configuration

```typescript
const meridian = await Meridian.create({
  providers: {
    openai: {
      auth: { token: "sk_openai" },
      rateLimit: {
        tokensPerSecond: 5,     // Limit rate to 5 requests per second locally
        maxTokens: 20,          // Capacity bucket size
        adaptiveBackoff: true,  // Automatically adapt rate on high usage
        queueSize: 50           // Max queued requests before failing fast
      }
    }
  },
  localUnsafe: true
});
```

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tokensPerSecond` | `number` | `10` | The number of tokens added to the bucket per second. Mapped to the API limit. |
| `maxTokens` | `number` | `100` | The maximum capacity size of the token bucket. |
| `adaptiveBackoff` | `boolean` | `true` | When enabled, dynamically decreases the local request rate if remaining capacity drops below 20%. |
| `queueSize` | `number` | `50` | The maximum queue size for rate-limited requests. Excess requests throw a `"Rate limit queue is full"` error. |

---

## Out-of-Band Syncing (Distributed Rate Limiting)

If your app runs across multiple servers, each instance has its own local token bucket, which could collectively exceed the third-party limits.

In distributed mode, Meridian coordinates token consumption using your shared `StateStorage` (e.g. Redis), ensuring compliance across all active instances.

```typescript
const meridian = await Meridian.create({
  providers: {
    stripe: { auth: { apiKey: "sk_key" } }
  },
  mode: "distributed",
  stateStorage: new RedisStateStorage(redisClient) // Coordinated rate limits across servers
});
```
