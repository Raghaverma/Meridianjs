# Upgrade Guide

> Looking to move *to* Meridian from another SDK or framework (OpenAI SDK, Stripe SDK, OpenRouter, LangChain)? See the [migration guides](migrations/index.md) instead.

---

## v0.3.4 to v0.4.0

Two new, additive features — no breaking changes, no migration steps required.

### Added

| Feature | What it is | Docs |
|---|---|---|
| **Meridian Studio** | Local dashboard for provider health, costs, circuit states, failovers, replay timelines, and schema drift. `await meridian.studio()` (in-process, live) or `meridian studio` (CLI, disk-only). | [docs/studio.md](studio.md) |
| **`meridianjs/ai`** | Vercel AI SDK middleware (`meridianReliability()`, used with `wrapLanguageModel`). Real failover between language models — no request/response translation needed, because the AI SDK already normalizes every provider. Adds `ai` and `@ai-sdk/provider` as optional peer dependencies. | [docs/ai-sdk.md](ai-sdk.md) |

### Also fixed

The README's flagship example and `demos/failover.ts` previously claimed `meridian.service("llm")!.post(...)` automatically fails over from OpenAI to Anthropic. It doesn't — `POST`/`PATCH` failover was correctly disabled back in v0.3.0 (see the `#2` entry below) to avoid duplicate side effects, but the docs/demo hadn't caught up. Both now demonstrate the real, current behavior: `GET` fails over automatically; `POST` surfaces its error instead of risking a duplicate charge or duplicate LLM call. If you copied that example, switch to `meridianjs/ai` for real LLM failover, or see [docs/failover/index.md](failover/index.md) for the idempotent-only rule and how to route writes yourself.

---

## v0.3.3 to v0.3.4

Version alignment release — no API or behaviour changes. The Rust client (`Cargo.toml`) and Python client (`pyproject.toml`) are now versioned in sync with the engine. No migration steps required.

---

## v0.3.2 to v0.3.3

Meridian v0.3.2 is a hardening release. All fixes are automatic — no API or config changes required.

### Fixed Issues

| Issue | Impact | Change |
|-------|--------|--------|
| **#7 — RateLimiter bucket not drained on 429** | Tokens already in the bucket let requests bypass the `Retry-After` window | `handle429` now drains the bucket to zero alongside pausing refills |
| **#8 — OffsetPaginationStrategy cycle-detects on page 2** | Providers that don't echo `offset` in the response body produce the same cursor every page, crashing with "Pagination cycle detected" | Strategy tracks the last sent offset internally; response body is optional |
| **#9 — `paginate()` throws on the boundary page** | A run that ends naturally on exactly the 1000th page raised a spurious "infinite pagination loop" error after all data was already yielded | Generator returns cleanly on natural completion; limit guard only fires on genuine truncation |

No migration steps required.

---

## v0.2.3 to v0.3.0

Meridian v0.3.0 fixes six critical reliability and security issues discovered during comprehensive testing. **All fixes are automatic** — no code changes are required, but behavior changes deserve awareness.

### Fixed Issues

| Issue | Impact | Change |
|-------|--------|--------|
| **#1 — RateLimiter adaptive backoff collapse** | SDK silently throttles all requests to ~0.5 req/s after first API call | Adaptive backoff now recovers to baseline when utilization ≤ 80%; no more permanent degradation |
| **#2 — Failover replays non-idempotent writes** | POST requests fail over and charge twice; double mutations | POST/PATCH no longer failover; throw original error requiring caller reconciliation |
| **#3 — Stripe webhook timestamp freshness** | Old captured webhooks replay forever, drive duplicate fulfillment | Webhooks older than 300s are automatically rejected; matches Stripe's own 5-minute tolerance |
| **#4 — Offset pagination advances forever** | Requests without a total count iterate up to 1000 pages then throw | Pagination terminates cleanly on empty page when total is unavailable |
| **#5 — IdempotencyResolver regex crash** | Override keys with special chars (e.g., `POST /charge(v2`) crash during idempotency lookup | Regex metacharacters are escaped; uncompilable patterns silently don't match |
| **#6 — Circuit breaker counts retries** | Retry loop inflates failure count 3-6× faster than config implies | Breaker now counts logical requests, not physical attempts; architecture moved outside retry |

### Migration Notes

**Failover Behavior Change (#2):** If you have multi-provider services with POST/PATCH methods, these now throw on the first provider's error instead of attempting a second provider. This is the correct behavior for non-idempotent operations, but you may need to add explicit error handling to reconcile state (e.g., checking whether the charge was actually processed before retrying).

```typescript
// Before: post request automatically failed over to provider B
// After: post request throws immediately, requires caller handling
try {
  await meridian.service("payment").post("/charges", chargeData);
} catch (err) {
  // Reconcile: check if charge was actually created before retrying
  const charge = await stripeAdmin.charges.retrieve(chargeData.idempotencyKey);
  if (!charge) {
    // Safe to retry with a new idempotency key
    throw err;
  }
}
```

All other fixes are transparent and require no code changes.

---

## v0.x to v0.2.3

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
