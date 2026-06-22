---
updated: 2026-06-23
---

# OpenAI Outage? Build Automatic Anthropic Failover in TypeScript

OpenAI has a status page. It's green right now. It won't always be.

When it goes red, your app has a choice: fail with a 503, or route to Anthropic automatically. Most apps fail.

Here's how to build automatic failover so your app keeps running.

---

## What happens without failover

Your current code probably looks something like this:

```typescript
const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: prompt }],
});
```

When OpenAI is down, this throws. Your error handler catches it, your users see an error, your on-call gets paged.

The typical manual fix is something like:

```typescript
async function callLLM(prompt: string) {
  try {
    return await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: prompt }] });
  } catch {
    // Fallback to Anthropic
    return await anthropic.messages.create({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: prompt }] });
  }
}
```

This is fragile. It doesn't distinguish transient errors from outages. It doesn't back off on rate limits. It re-implements the Anthropic call by hand instead of normalizing it. And it grows: next you add Gemini, then you need circuit breaking so you stop hammering a dead provider on every request.

---

## A better approach: wrap the model, not the call

The problem with rolling your own fallback isn't just the missing retry/circuit-breaker logic — it's that OpenAI and Anthropic don't share a request or response shape, so any generic "try provider A, then provider B" router needs a translation layer for every pair of providers it might route between.

The [Vercel AI SDK](https://ai-sdk.dev) already solved that: every provider it supports implements the same `doGenerate`/`doStream` interface. Meridian's `meridianjs/ai` middleware wraps that interface with retries, a circuit breaker, and failover — so your application calls one `model`, never `"openai"` or `"anthropic"` directly:

```bash
npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
```

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5"), google("gemini-2.5-pro")],
    failoverOn: ["rate_limit", "network", "provider"],
  }),
});

// Your application calls `model` — it never knows which vendor responded
const { text, response } = await generateText({ model, prompt });

console.log(response.modelId);  // whichever model actually generated this
```

When OpenAI is down, the middleware routes to Anthropic, then Gemini, automatically. Your application code doesn't change.

---

## What the failover sequence looks like

```
generateText({ model, prompt })
        │
        ├─ try openai (gpt-4o)
        │    └─ 503 Service Unavailable  (category: "provider")
        │
        ├─ try anthropic (claude-opus-4-5)   ← automatic
        │    └─ 200 OK
        │
        └─ return { text, response: { modelId: "claude-opus-4-5-..." } }
```

This is safe even though a chat completion is technically a write: providers bill only for completions actually returned, so a call that errors before producing output can't be double-charged by retrying it on a different model. That's a meaningful difference from a generic POST router, which never auto-fails-over a write — see [docs/failover/index.md](../docs/failover/index.md) for why that rule exists at the HTTP layer.

---

## Circuit breaking: stop hammering a dead provider

Without a circuit breaker, every request during an outage hits OpenAI first, waits for it to fail, then falls back. With a 5-second timeout, 100 req/s means 500 open connections, cascading timeouts, and memory pressure.

`meridianReliability()` keeps a circuit breaker per model. After 5 failures, it opens — subsequent calls skip straight to the next fallback without waiting for a timeout:

```typescript
meridianReliability({
  fallbacks: [anthropic("claude-opus-4-5")],
  circuitBreaker: {
    failureThreshold: 5,     // open after 5 consecutive failures
    timeout: 30_000,         // try again after 30 seconds
    volumeThreshold: 10,     // need 10 requests in window before % check runs
    rollingWindowMs: 60_000, // 1-minute rolling window
    errorThresholdPercentage: 50,
  },
});
```

Once open, a request that would have waited 5 seconds for OpenAI to time out now fails in under 1 millisecond and routes to Anthropic immediately.

---

## Observability: know when failover is happening

Pass an `ObservabilityAdapter` to track it — the same interface Meridian's HTTP layer uses:

```typescript
import { AnalyticsCollector } from "meridianjs";

const analytics = new AnalyticsCollector();
const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5")],
    observability: [analytics],
  }),
});

// ...after some traffic
console.log(analytics.get());
// {
//   openai:    { requests: 1200, errorRate: "3.2%", avgLatency: 340 },
//   anthropic: { requests:   42, errorRate: "0.0%", avgLatency: 280 },
// }

console.log(analytics.getHealth());
// {
//   openai:    { status: "down",    successRate: "61.2%" },
//   anthropic: { status: "healthy", successRate: "100.0%" },
// }
```

Alert when `getHealth().openai.status === "down"`. Recover automatically when the circuit closes.

---

## Next steps

- [Vercel AI SDK middleware](../docs/ai-sdk.md) — full option reference, streaming semantics, what's out of scope
- [Failover strategies](../docs/failover/index.md) — the HTTP-layer rules this middleware deliberately diverges from, and why
- [Circuit breaker internals](../docs/circuit-breaker.md) — how the algorithm works
- [Reliability Lab](../examples/reliability-lab/index.ts) — run a full outage simulation locally

```bash
npm install meridianjs
npx vite-node examples/reliability-lab/index.ts
```
