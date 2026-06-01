# Migration Guide (v0.x to v0.2.3)

Meridian v0.2.3 introduces structural improvements to request execution safety, distributed coordination, and the custom adapter interface. This guide details the steps to upgrade your application.

---

## 1. Asynchronous Client Initialization

In v0.x, the client was created using the `new` operator:

```typescript
// OLD (v0.x)
import { Meridian } from "meridianjs";
const meridian = new Meridian(config);
```

In v0.2.3, to support async auth strategies, token discovery, and state storage connections, you must use the static asynchronous `Meridian.create` method:

```typescript
// NEW (v0.2.3)
import { Meridian } from "meridianjs";
const meridian = await Meridian.create(config);
```

---

## 2. Shared State Persistence (Distributed Mode)

If you run Meridian in production (serverless functions, Kubernetes nodes, or multi-instance containers), you must opt-in to persistence to avoid local rate-limit and circuit breaker state resets.

```typescript
// NEW (v0.2.3)
import { Meridian, RedisStateStorage } from "meridianjs";
import { createClient } from "redis";

const redisClient = createClient({ url: "redis://localhost:6379" });
await redisClient.connect();

const meridian = await Meridian.create({
  providers: {
    stripe: { auth: { apiKey: "sk_key" } }
  },
  mode: "distributed",                             // REQUIRED for multi-instance
  stateStorage: new RedisStateStorage(redisClient) // REQUIRED
});
```

To run in-memory locally, you must explicitly opt-in via `localUnsafe: true`:

```typescript
const meridian = await Meridian.create({
  providers: { ... },
  localUnsafe: true // Opt-in to in-memory state tracking locally
});
```

---

## 3. Custom Adapter Contract (LegacyProviderAdapter Removal)

The legacy `LegacyProviderAdapter` interface has been completely removed in favor of the pipeline-optimized `ProviderAdapter` contract. 

| Old Method (v0.x) | New Method (v0.2.3) |
|---|---|
| `authenticate(config)` | `authStrategy(config)` |
| `makeRequest(endpoint, options, token)` | Removed. Split into `buildRequest(input)` (which builds options) and automatic execution by the pipeline. |
| `normalizeResponse(raw)` | `parseResponse(raw)` |
| `parseRateLimit(headers)` | `rateLimitPolicy(headers)` |
| `getPaginationStrategy()` | `paginationStrategy()` |

For a complete example of the new `ProviderAdapter` implementation, see the [Adapters Guide](adapters.md).
