---
title: "How to Automatically Fail Over Between OpenAI and Anthropic in Node.js"
description: "Stop letting OpenAI outages crash your app. Set up automatic LLM provider failover with Meridian.js in under 10 minutes."
tags: openai, anthropic, nodejs, typescript, reliability
date: 2026-06-05
---

# How to Automatically Fail Over Between OpenAI and Anthropic in Node.js

In March 2024, OpenAI experienced a multi-hour API outage that took down applications worldwide. If your product used OpenAI directly — and most did — your users hit 500 errors while you frantically refreshed the status page. No code change you could ship in that moment would have helped.

The bitter part? Anthropic's Claude API was fine the entire time.

This article shows you how to set up automatic LLM provider failover so the next outage is a non-event for your users.

## The Naive Fix: try/catch with Manual Retry

The first instinct is to wrap your OpenAI call and fall back manually:

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function chat(message: string) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
    });
    return res.choices[0].message.content;
  } catch (err) {
    // hope this works
    const res = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: message }],
    });
    return res.content[0].type === "text" ? res.content[0].text : "";
  }
}
```

This looks reasonable until you think through what it's missing:

- **No circuit breaker.** If OpenAI is flapping, every request tries OpenAI first, fails, then falls back. You're paying double latency on every call during degraded periods.
- **No observability.** You have no idea how often failover is triggering, which provider handled a given request, or what the p95 latency looks like across providers.
- **Schema differences.** OpenAI and Anthropic have completely different response shapes. The catch block is a re-implementation, not a fallback.
- **No retry strategy.** A single 503 shouldn't trigger failover — a transient error should retry on the same provider first.

The more providers you add, the worse this gets. Two providers doubles the code; three triples it.

## The Right Fix: Provider-Agnostic Service Abstraction

Install Meridian.js:

```bash
npm install meridianjs
```

Then configure your LLM service with both providers:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:    { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
  },
  services: {
    llm: {
      providers: ["openai", "anthropic"],
      strategy: "failover",
    },
  },
});
```

Now your call site looks like this:

```typescript
const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Summarize this contract." }],
  },
});

console.log(data);              // response body
console.log(meta.provider);    // "openai" or "anthropic"
```

The service layer handles retries on the primary provider before promoting to failover. A transient rate limit doesn't trigger a provider switch — a genuine outage does. The circuit breaker tracks error rates per provider and stops attempting a degraded one automatically.

## Verifying Failover Actually Happened

The `meta` object is your audit trail:

```typescript
const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] },
});

console.log({
  provider:       meta.provider,                  // which provider answered
  latency:        meta.trace.latency,             // ms for this request
  retries:        meta.trace.retries,             // how many retries before success
  circuitBreaker: meta.trace.circuitBreaker,      // "OPEN" | "CLOSED" | "HALF_OPEN"
});
```

In your logging pipeline, emit `meta.provider` on every LLM call. When OpenAI is down, you'll see `meta.provider === "anthropic"` spike in your logs — without a single user-facing error. That's the signal that failover is working.

You can also pull aggregate health at any time:

```typescript
const health = meridian.health();
// {
//   openai:    { status: "degraded", successRate: "71.2%", circuitBreaker: "OPEN" },
//   anthropic: { status: "healthy",  successRate: "99.8%", circuitBreaker: "CLOSED" }
// }
```

When `circuitBreaker` is `"OPEN"` for a provider, Meridian stops routing to it until it recovers — no wasted latency on requests destined to fail.

## Beyond Failover: Lowest-Latency and Weighted Routing

Failover is just one strategy. If you're optimizing for response time rather than reliability alone, switch to `latency`:

```typescript
services: {
  llm: {
    providers: ["openai", "anthropic"],
    strategy: "latency",   // always routes to whichever is faster right now
  },
},
```

Or use `weighted` to split traffic by ratio — useful for A/B testing models:

```typescript
services: {
  llm: {
    providers: ["openai", "anthropic"],
    strategy: "weighted",
    weights: { openai: 80, anthropic: 20 },
  },
},
```

Check analytics to see how each provider is performing over time:

```typescript
const stats = meridian.analytics();
// {
//   openai:    { requests: 1000, errorRate: "0.5%", avgLatency: 320, p95Latency: 650 },
//   anthropic: { requests: 200,  errorRate: "0.1%", avgLatency: 280, p95Latency: 510 }
// }
```

You get this data without instrumenting anything extra — it's tracked at the service layer automatically.

## Ship It

The next OpenAI outage will happen. The only question is whether your app handles it gracefully or you spend 40 minutes wiring up a manual fallback under pressure.

Setting this up takes one config block and ten minutes. The return is that LLM provider downtime stops being a production incident.

`npm install meridianjs` — full docs at [npmjs.com/package/meridianjs](https://www.npmjs.com/package/meridianjs).
