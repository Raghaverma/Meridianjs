# Migrating from OpenRouter to Meridian

OpenRouter gives you one endpoint, one API key, and one bill for many LLM providers, with `model: "<provider>/<model>"` picking the backend and an optional `models: [...]` list for fallback. Meridian's `meridianjs/ai` middleware gives you the same fallback behavior, but **in-process, with your own provider API keys, and no extra network hop** — by wrapping the [Vercel AI SDK](https://ai-sdk.dev), which already normalizes every provider into one interface, the same way OpenRouter does server-side.

This guide maps OpenRouter's request shape onto `meridianjs/ai`.

## 1. Install and initialize

```diff
- // no SDK needed — OpenRouter is called via fetch
+ npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
```

```typescript
// Before — one key, one endpoint, model name picks the provider
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
const { choices } = await res.json();
```

```typescript
// After — your own keys for each provider you actually use
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({ fallbacks: [anthropic("claude-opus-4-5")] }),
});

const { text, response } = await generateText({
  model,
  prompt: "Summarize this contract.",
});
console.log(response.modelId); // which provider actually served this
```

## 2. Mapping `model: "<provider>/<model>"`

OpenRouter encodes the provider in the model string. With `meridianjs/ai`, you import the provider's AI SDK package directly and construct the model object — the provider is part of the import, not a routing decision made at request time:

| OpenRouter | `meridianjs/ai` |
|---|---|
| `model: "openai/gpt-4o"` | `openai("gpt-4o")` from `@ai-sdk/openai` |
| `model: "anthropic/claude-opus-4-5"` | `anthropic("claude-opus-4-5")` from `@ai-sdk/anthropic` |
| `model: "google/gemini-2.5-pro"` | `google("gemini-2.5-pro")` from `@ai-sdk/google` |

If you need to call a *specific* provider without any fallback, just `wrapLanguageModel({ model: openai("gpt-4o"), middleware: meridianReliability() })` with no `fallbacks` — you still get retries and a circuit breaker, with no routing.

## 3. Mapping fallback lists

OpenRouter's `models: [...]` (with `route: "fallback"`) tries models in order until one succeeds. `meridianReliability()`'s `fallbacks` option does the same, plus a circuit breaker per model (a model that's already failing gets skipped instantly instead of retried until timeout):

```typescript
// Before
body: JSON.stringify({
  models: ["openai/gpt-4o", "anthropic/claude-opus-4-5", "google/gemini-2.5-pro"],
  route: "fallback",
  messages: [{ role: "user", content: "Summarize this contract." }],
})
```

```typescript
// After
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5"), google("gemini-2.5-pro")],
  }),
});

const { text } = await generateText({ model, prompt: "Summarize this contract." });
```

This is also why `meridianjs/ai` exists as a separate path from Meridian's general `service()` abstraction: OpenAI, Anthropic, and Gemini don't share a request/response shape, and `service()` only auto-fails-over idempotent methods (never a chat completion, which is a `POST`) — see [docs/failover/index.md](../failover/index.md). The AI SDK's normalization is what makes failover possible *and* safe here.

## 4. Headers you can drop

OpenRouter-specific headers (`HTTP-Referer`, `X-Title` for leaderboard attribution, the single `Authorization: Bearer OPENROUTER_KEY`) go away entirely — each provider is authenticated with its own key, passed to its AI SDK package (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` env vars, read automatically by `@ai-sdk/openai`/`@ai-sdk/anthropic`).

## 5. Cost and usage tracking

OpenRouter reports cost per request via its response `usage` field and a separate `/generation` endpoint. The AI SDK's `generateText`/`streamText` results already include token usage (`result.usage.inputTokens`/`outputTokens`/`totalTokens`) — multiply by your provider's published per-token price for cost. For aggregate stats across models, pass an `ObservabilityAdapter`:

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

// later
console.log(analytics.get());
// { openai: { requests: 412, avgLatency: 320 }, anthropic: { requests: 38, avgLatency: 410 } }
```

## 6. What changes operationally

| | OpenRouter | Meridian (`meridianjs/ai`) |
|---|---|---|
| Where requests go | Your app → OpenRouter → provider | Your app → provider, directly |
| API keys | One OpenRouter key | Your own key per provider |
| Billing | Consolidated through OpenRouter (with markup) | Direct to each provider |
| Availability dependency | Your app + OpenRouter + provider | Your app + provider |
| Non-LLM providers (payments, KYC, comms) | Not covered — separate SDKs needed | Meridian's `provider()`/`service()` (a different API — see [docs/failover/index.md](../failover/index.md) for why payments failover looks different from LLM failover) |

## When to keep OpenRouter

If you specifically want access to a long tail of niche/open-source models without managing individual provider accounts, or LLMs are genuinely the *only* third-party dependency your app has, OpenRouter's hosted simplicity may still be the right call. See [Meridian vs. OpenRouter](../comparisons/openrouter.md) for the full breakdown.

## Checklist

- [ ] Create accounts/API keys directly with the providers you actually use (OpenAI, Anthropic, Gemini, ...)
- [ ] Install `ai` + each provider's AI SDK package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, ...)
- [ ] Replace the single OpenRouter `fetch` call with `wrapLanguageModel({ model, middleware: meridianReliability() })` + `generateText`/`streamText`
- [ ] Convert `model: "<provider>/<model>"` into an import from that provider's AI SDK package
- [ ] Convert `models: [...] + route: "fallback"` into `meridianReliability({ fallbacks: [...] })`
- [ ] Drop OpenRouter-specific headers (`HTTP-Referer`, `X-Title`)
- [ ] Replace OpenRouter's cost dashboard with `result.usage` + an `AnalyticsCollector` observability adapter
