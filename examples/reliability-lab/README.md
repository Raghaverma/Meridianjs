# Reliability Lab

A self-contained, runnable demo that simulates a real outage sequence. No API keys required — everything runs in-process using `MockAdapter`s.

```bash
npx vite-node examples/reliability-lab/index.ts
# or
npm run example:reliability-lab
```

## What it shows

```
── Phase 1 — Normal operation
  ✓ call #1 succeeded    provider="openai"   cb="CLOSED"

── Phase 2 — OpenAI outage → automatic failover
  ⇢ call #1 failed over to anthropic   provider="anthropic"
  ⇢ call #2 failed over to anthropic   provider="anthropic"

── Phase 3 — Circuit breaker opens
  · sending 5 direct requests to openai to trip the breaker…
  ⊘ circuit OPEN   failures=3
  ✗ fail-fast   blocked in 0ms — no network call made

── Phase 4 — OpenAI recovers → circuit closes
  · waiting for circuit timeout (200ms)…
  ✓ probe #1 succeeded — circuit is now HALF_OPEN
  ✓ probe #2 succeeded — circuit is now CLOSED

── Phase 5 — Stripe 429 → retry with backoff
  · stripe will rate-limit twice then succeed
  ✓ charge succeeded after 2 retries (64ms total)

── Analytics summary
  · openai     17 reqs  41.2% success  0ms avg
  · anthropic   4 reqs  100.0% success  0ms avg
  · stripe      1 reqs  100.0% success  64ms avg
```

## Key concepts demonstrated

| Phase | Concept | Code path |
|---|---|---|
| 1 | Normal routing | `service("llm").get()` → primary provider |
| 2 | Provider failover | `openai` throws → `ServiceClient` routes to `anthropic` |
| 3 | Circuit breaker opens | 5 failures → `ProviderCircuitBreaker` state = `OPEN` |
| 3 | Fail-fast | Blocked in < 1 ms, no network call made |
| 4 | Circuit recovery | Cooldown expires → `HALF_OPEN` → 2 probes succeed → `CLOSED` |
| 5 | Retry with backoff | `RetryStrategy` catches `rate_limit` error, retries 3× with exponential delay |

## How the mock network works

The Meridian pipeline dispatches through `globalThis.fetch`. The lab installs a shim that routes each request by hostname to the right `MockAdapter`:

```
fetch("https://api.openai.com/…")    → openai  MockAdapter
fetch("https://api.anthropic.com/…") → anthropic MockAdapter
fetch("https://api.stripe.com/…")    → stripe  MockAdapter
```

Each adapter can be switched between healthy / down / rate-limited at any point in the demo, giving full control over the outage sequence without touching a real network.
