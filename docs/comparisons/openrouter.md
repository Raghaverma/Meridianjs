# Meridian vs. OpenRouter

OpenRouter is a **hosted proxy** that gives you one API and one bill for dozens of LLM providers, with automatic routing and fallback between models. It solves a real problem: "I don't want to manage API keys and request shapes for every LLM provider separately."

Meridian solves a superset of that problem, for *every* provider category — not just LLMs — and does it **in-process**, with your own API keys, with no extra network hop.

## The comparison

| Concern | OpenRouter | Meridian |
|---|---|---|
| LLM routing & fallback | ✅ | ✅ `meridianjs/ai` middleware (`wrapLanguageModel`) — real failover, no request translation |
| Unified LLM request/response shape | ✅ (OpenRouter normalizes server-side) | ✅ (the Vercel AI SDK normalizes client-side; Meridian wraps that) |
| Payments (Stripe, Razorpay, Adyen, ...) | ❌ | ✅ |
| KYC / Identity (HyperVerge, Digio, Karza, ...) | ❌ | ✅ |
| Communications (Twilio, SendGrid, MSG91, ...) | ❌ | ✅ |
| Logistics, CRM, Auth, Maps, etc. | ❌ | ✅ |
| Vendor-agnostic application architecture | Partial — only covers LLM calls | ✅ — `meridianjs/ai` for LLM calls, `service()`/`provider()` for everything else, same observability interface across both |
| Deployment model | Hosted proxy — your traffic and (for some setups) your keys route through OpenRouter's infrastructure | npm package — runs in-process, your keys never leave your infrastructure |
| Extra network hop | Yes — app → OpenRouter → provider | No — app → provider directly |
| Circuit breakers | ❌ (provider-side routing, not client-visible breaker state) | ✅ Per-provider, inspectable via `meta.trace.circuitBreaker` |
| Schema drift detection | ❌ | ✅ `meridian.schema.check()` |
| Policy engine (PII blocking, redaction, region rules) | ❌ | ✅ |
| Self-hostable / no third-party dependency | ❌ — requires OpenRouter as a service | ✅ — zero runtime dependencies, you own the process |
| Billing | Consolidated through OpenRouter (markup on top of provider pricing) | Direct to each provider — Meridian only tracks/estimates via `meridian.cost()` |

## What this looks like in code

**OpenRouter** — one endpoint, one key, model name picks the provider:

```typescript
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "Summarize this contract." }],
  }),
});
```

This is simple — but your LLM traffic now depends on OpenRouter's availability, billing, and rate limits *in addition to* the underlying provider's. And it only covers LLMs: the payments call to Stripe and the SMS call to Twilio in the same app still need their own SDKs, error handling, and retry logic.

**Meridian** — same failover concept, but it's your infrastructure, your keys, and the same pattern extends to every other provider category:

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { Meridian } from "meridianjs";
import { meridianReliability } from "meridianjs/ai";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_KEY! } },
    twilio: { auth: { username: process.env.TWILIO_SID!, password: process.env.TWILIO_TOKEN! } },
  },
});

// LLM call — fails over to Anthropic on a retryable OpenAI error, with a
// circuit breaker per model. The AI SDK already normalizes both providers,
// so there's no request shape to reconcile.
const llm = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({ fallbacks: [anthropic("claude-opus-4-5")] }),
});
await generateText({ model: llm, prompt: "Summarize this contract." });

// Payments — same client shape, same observability, same policy engine
await meridian.provider("stripe")!.post("/v1/charges", { body: { amount: 2000 } });

// Communications — same again
await meridian.provider("twilio")!.post("/2010-04-01/Accounts/.../Messages.json", { body: { ... } });
```

## When OpenRouter is the right call

- You specifically want access to a long tail of LLM models (open-source, niche providers) through one API without managing individual provider accounts.
- You're fine with a hosted proxy in the request path and consolidated billing with OpenRouter's markup.
- LLMs are the *only* third-party dependency you need to make resilient.

## The short version

OpenRouter is "one API for many LLMs, hosted by someone else." Meridian is "one reliability layer for every provider you call, running inside your own process." If your app only ever talks to LLMs and you're fine with a hosted proxy, OpenRouter is simpler. The moment your app also talks to payments, KYC, communications, or anything else — and you want failover, circuit breakers, and drift detection applied consistently — Meridian covers ground OpenRouter doesn't.
