# Meridian vs. Raw SDKs

**The default.** Most teams start here: `npm install openai stripe razorpay @anthropic-ai/sdk twilio ...` and call each one directly. It works — until a provider has an outage, changes a field name, or rate-limits you in production at 2am.

Raw SDKs aren't bad. They're just missing everything that happens *between* "the SDK call" and "a reliable production system" — and every team ends up writing that part themselves, once per provider, forever.

## The comparison

| Concern | Raw SDKs | Meridian |
|---|---|---|
| Error shapes | Different per provider (`error.code`, `error.type`, HTTP status, nested bodies...) | One `MeridianError` — always `category`, `retryable`, `retryAfter` |
| Retries | Manual, usually missing or copy-pasted | Built-in exponential backoff, idempotency-safe |
| Circuit breakers | Manual, rarely implemented | Automatic, per-provider, opens after N failures |
| LLM provider failover | Hand-written `try { openai } catch { anthropic }` per call site | `meridianjs/ai` middleware (`wrapLanguageModel`) — real failover, no request translation |
| Other provider routing (payments, comms, ...) | Hand-written per call site | `service()` with `failover` / `round-robin` / `lowest-latency` / `weighted` / `geo` strategies — for idempotent methods; see [docs/failover/index.md](../failover/index.md) for the write-safety rule |
| Rate limit parsing | Per-provider headers (`x-ratelimit-remaining` vs `Retry-After` vs ...) | `meta.rateLimit` — normalized across all providers |
| Pagination | cursor / offset / link-header — different per provider | `meta.pagination` + `for await (const page of provider.paginate(...))` |
| Schema drift | Silent — you find out when production breaks | `meridian.schema.check()` flags `FIELD_REMOVED` / `TYPE_CHANGED` before deploy |
| Observability | DIY logging, DIY metrics, DIY tracing | `meta.trace` on every response; `analytics()`, `health()`, `cost()`; OTel/Prometheus adapters |
| Policy enforcement (PII blocking, redaction, region rules) | DIY middleware, written per integration | Built-in policy engine — runs before every request |
| Cross-provider transactions | DIY saga code, easy to get rollback ordering wrong | `meridian.transaction([...])` with automatic compensating rollbacks |
| Webhook signature verification | Per-provider (HMAC-SHA256, SHA1, Ed25519, ...) — look up each one | `adapter.verifyWebhook(payload, signature, secret)` — same call shape everywhere |

## What this looks like in code

**Without Meridian** — calling OpenAI directly, with a hand-rolled fallback to Anthropic:

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY! });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY! });

async function complete(prompt: string) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
    });
    return res.choices[0].message.content;
  } catch (err: any) {
    // Is this retryable? Is it a rate limit? Is it an outage?
    // You have to know OpenAI's error shape to find out.
    if (err.status === 429 || err.status === 503) {
      // Anthropic's request/response shape is completely different —
      // this fallback has to be written by hand, per call site.
      const res = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      return res.content[0].type === "text" ? res.content[0].text : "";
    }
    throw err;
  }
}
```

**With Meridian** — one call, normalized errors, automatic failover, via the Vercel AI SDK middleware (OpenAI and Anthropic don't share a request shape, and a chat completion is a `POST`, so this goes through `meridianjs/ai` rather than the general `service()` abstraction — see [docs/ai-sdk.md](../ai-sdk.md)):

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({ fallbacks: [anthropic("claude-opus-4-5")] }),
});

const { text, response } = await generateText({ model, prompt });

response.modelId  // which model served the request
```

For everything that isn't an LLM call — Stripe, Razorpay, Twilio, or any of the other 43 adapters — the same `service(...)` / `provider(...)` / `meta.trace` shape applies via Meridian's general HTTP layer, with the idempotent-methods-only failover rule in [docs/failover/index.md](../failover/index.md).

## When raw SDKs are still the right call

- You're calling exactly one provider, you don't need failover, and the provider's SDK already gives you what you need (file uploads, SDK-specific helpers, beta endpoints Meridian hasn't wrapped yet).
- You need a provider-specific feature that isn't yet exposed through Meridian's normalized surface — `meridian.provider("x")` still gives you `.get/.post/.put/.patch/.delete/.paginate/.stream/.batch`, but very new or obscure endpoints may need the native SDK until an adapter is updated.

Meridian doesn't ask you to give up the provider SDK ecosystem — it asks you to put a reliability layer in front of it so that one provider's bad day doesn't become your incident.
