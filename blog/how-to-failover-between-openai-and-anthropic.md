---
title: "How to Automatically Fail Over Between OpenAI and Anthropic in Node.js"
description: "Stop letting OpenAI outages crash your app. Set up automatic LLM provider failover with Meridian.js in under 10 minutes."
tags: openai, anthropic, nodejs, typescript, reliability
date: 2026-06-05
updated: 2026-06-23
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

## The Right Fix: Wrap the Model, Not the Call

You might reach for a generic HTTP-level "service" abstraction here — call one endpoint, let a router pick the provider underneath. That works when providers share a request/response shape (two payment gateways, two SMS senders). It does **not** work for chat completions: OpenAI and Anthropic disagree on required fields, message format, and response shape, so there's nothing generic to route to. And a chat completion is a write — a naive router that blindly retries a failed write on a different provider risks running (and billing) the same generation twice.

The actual fix for this specific problem is the [Vercel AI SDK](https://ai-sdk.dev): it already normalizes every provider into one `doGenerate`/`doStream` interface, so there's no schema-translation problem left to solve. Meridian's `meridianjs/ai` middleware wraps that normalized interface with retries, a circuit breaker, and failover:

```bash
npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic
```

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5")],
    retry: { maxRetries: 2, baseDelay: 200 },
  }),
});

const { text, response } = await generateText({ model, prompt: "Summarize this contract." });

console.log(text);              // the completion
console.log(response.modelId);  // which model actually answered
```

The middleware retries the primary model first (a transient rate limit doesn't trigger failover — a genuine outage does), then moves to Anthropic only once retries are exhausted. The circuit breaker tracks failures per model and stops calling a degraded one until it recovers.

This is also why failover here is safe even though chat completions are writes: providers bill only for completions actually returned, so a call that errors before producing output can't be double-charged by retrying it or trying a different model. That's a real distinction from Meridian's HTTP service layer (used for REST APIs like payments), which never auto-fails-over a `POST` — see [docs/failover/index.md](https://github.com/Raghaverma/meridianjs/blob/main/docs/failover/index.md) for why.

## Verifying Failover Actually Happened

`response.modelId` is your audit trail — log it on every call:

```typescript
const { text, response } = await generateText({ model, prompt: message });
console.log({ provider: response.modelId });
```

When OpenAI is down, you'll see Anthropic's model ID spike in your logs — without a single user-facing error. That's the signal that failover is working.

For aggregate stats, pass an `ObservabilityAdapter` — the same interface Meridian's HTTP layer uses:

```typescript
import { AnalyticsCollector } from "meridianjs";
import { meridianReliability } from "meridianjs/ai";

const analytics = new AnalyticsCollector();
const middleware = meridianReliability({
  fallbacks: [anthropic("claude-opus-4-5")],
  observability: [analytics],
});

// later
console.log(analytics.get());
// {
//   openai:    { requests: 1000, errorRate: "0.5%", avgLatency: 320 },
//   anthropic: { requests: 12,   errorRate: "0.0%", avgLatency: 410 }
// }
```

A spike in the Anthropic row's `requests` count, with `openai`'s error rate climbing alongside it, is exactly what an outage looks like in these numbers.

## What This Doesn't Cover

To be precise about scope: `meridianReliability()` fails over **between models**, not between arbitrary strategies — there's no weighted-split or lowest-latency mode here (that's an HTTP-layer concept, for REST APIs with a shared request shape). It also doesn't retry mid-stream — only a `streamText()` call that fails before any token is emitted gets failed over; a connection that drops after streaming has started surfaces the error as-is, since silently retrying would duplicate output already sent to the caller. See [docs/ai-sdk.md](https://github.com/Raghaverma/meridianjs/blob/main/docs/ai-sdk.md) for the full picture.

## Ship It

The next OpenAI outage will happen. The only question is whether your app handles it gracefully or you spend 40 minutes wiring up a manual fallback under pressure.

Setting this up takes one `wrapLanguageModel` call and ten minutes. The return is that LLM provider downtime stops being a production incident.

`npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic` — full docs at [npmjs.com/package/meridianjs](https://www.npmjs.com/package/meridianjs).
