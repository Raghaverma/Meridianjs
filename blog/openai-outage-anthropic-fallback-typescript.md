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

This is fragile. It doesn't distinguish transient errors from outages. It doesn't back off on rate limits. And it grows: next you add Gemini, then you need weighted routing, then you need circuit breaking so you stop hammering a dead provider on every request.

---

## A better approach: service abstraction

The right fix is to decouple your application from the vendor. Your code calls `"llm"`, not `"openai"`.

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:    { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
    gemini:    { auth: { apiKey: process.env.GEMINI_API_KEY } },
  },
  services: {
    llm: {
      providers: ["openai", "anthropic", "gemini"],
      strategy: "failover",
      failoverOn: ["provider", "network", "rate_limit"],
    },
  },
});

// Your application calls "llm" — it never knows which vendor responded
const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  },
});

console.log(meta.provider);  // "openai" | "anthropic" | "gemini" — whoever responded
```

When OpenAI is down, the service layer routes to Anthropic automatically. Your application code doesn't change.

---

## What the failover sequence looks like

```
App → service("llm").post("/v1/chat/completions")
        │
        ├─ try openai
        │    └─ 503 Service Unavailable  (category: "provider")
        │
        ├─ try anthropic                   ← automatic
        │    └─ 200 OK
        │
        └─ return { data, meta: { provider: "anthropic" } }
```

The trace tells you exactly what happened:

```typescript
meta.provider          // "anthropic" — which provider succeeded
meta.trace.retries     // 0 — no retries, just routed around
meta.trace.latency     // 340 ms — time including the failed OpenAI attempt
meta.trace.circuitBreaker // "CLOSED"
```

---

## Circuit breaking: stop hammering a dead provider

Without a circuit breaker, every request during an outage hits OpenAI. With a 5-second timeout, 100 req/s means 500 open connections, cascading timeouts, and memory pressure.

Meridian includes a circuit breaker per provider. After 5 failures, it opens — subsequent requests skip OpenAI entirely and route to Anthropic without waiting for a timeout:

```typescript
providers: {
  openai: {
    auth: { apiKey: process.env.OPENAI_API_KEY },
    circuitBreaker: {
      failureThreshold: 5,     // open after 5 consecutive failures
      timeout: 30_000,         // try again after 30 seconds
      volumeThreshold: 10,     // need 10 requests in window before % check runs
      rollingWindowMs: 60_000, // 1-minute rolling window
      errorThresholdPercentage: 50,
    },
  },
}
```

Once open, a request that would have waited 5 seconds for OpenAI to time out now fails in under 1 millisecond and routes to Anthropic immediately.

---

## Provider-aware routing

Not all requests should fall back to Anthropic. A GPT-4o request uses OpenAI's specific format; Anthropic uses a different schema. For multi-provider fallback, you have two options:

**Option 1 — One service, one endpoint shape**

Use one provider's endpoint format and accept that the fallback provider may return a different response schema. For structured outputs this usually requires a normalisation layer.

**Option 2 — One service per capability tier**

```typescript
services: {
  // Primary: OpenAI, preferred
  reasoning: { providers: ["openai"],    strategy: "failover" },
  // Fallback: cheapest available
  draft:     { providers: ["anthropic", "gemini"], strategy: "cheapest",
                costs: { anthropic: 0.01, gemini: 0.002 } },
}
```

Your application uses `reasoning` for structured tasks and `draft` for drafts. Failover is implicit.

---

## Observability: know when failover is happening

Track failover events without instrumentation code:

```typescript
const stats = meridian.analytics();
// {
//   openai:    { requests: 1200, errorRate: "3.2%", avgLatency: 340 },
//   anthropic: { requests:   42, errorRate: "0.0%", avgLatency: 280 },
// }

const health = meridian.health();
// {
//   openai:    { status: "down",    circuitBreaker: "OPEN",   successRate: "61.2%" },
//   anthropic: { status: "healthy", circuitBreaker: "CLOSED", successRate: "100.0%" },
// }
```

Alert when `health().openai.status === "down"`. Recover automatically when the circuit closes.

---

## Next steps

- [Routing strategies](../docs/failover/index.md) — `lowest-latency`, `cheapest`, `weighted`, `geo`
- [Circuit breaker internals](../docs/circuit-breaker.md) — how the algorithm works
- [Reliability Lab](../examples/reliability-lab/index.ts) — run the full outage simulation locally

```bash
npm install meridianjs
npx vite-node examples/reliability-lab/index.ts
```
