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
