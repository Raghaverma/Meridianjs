# Migrating from OpenRouter to Meridian

OpenRouter gives you one endpoint, one API key, and one bill for many LLM providers, with `model: "<provider>/<model>"` picking the backend and an optional `models: [...]` list for fallback. Meridian gives you the same routing/fallback behavior, but **in-process, with your own provider API keys, and no extra network hop** — and the same pattern extends to payments, KYC, and communications providers in the same app.

This guide maps OpenRouter's request shape onto Meridian's `service("llm")`.

## 1. Install and initialize

```diff
- // no SDK needed — OpenRouter is called via fetch
+ npm install meridianjs
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
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai: { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
  },
  services: {
    llm: { providers: ["openai", "anthropic"], strategy: "failover" },
  },
});

const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
});
const { choices } = data;
console.log(meta.trace.provider); // which provider actually served this
```

## 2. Mapping `model: "<provider>/<model>"`

OpenRouter encodes the provider in the model string. With Meridian, the provider is selected by **routing** (which providers are in the `service`, and in what order/strategy), and the `model` field in the request body is just whatever that provider's API expects:

| OpenRouter | Meridian |
|---|---|
| `model: "openai/gpt-4o"` | `providers: { openai: {...} }`, body `{ model: "gpt-4o" }` |
| `model: "anthropic/claude-opus-4-5"` | `providers: { anthropic: {...} }`, body `{ model: "claude-opus-4-5" }` |
| `model: "google/gemini-2.0-flash"` | `providers: { gemini: {...} }`, body `{ model: "gemini-2.0-flash" }` |

If you need to call a *specific* provider directly rather than going through routing, use `meridian.provider("openai")` instead of `meridian.service("llm")` — same call shape, just bypasses routing.

## 3. Mapping fallback lists

OpenRouter's `models: [...]` (with `route: "fallback"`) tries models in order until one succeeds. Meridian's `service("llm")` does the same across providers, plus circuit breakers (a provider that's already failing gets skipped instantly instead of retried until timeout):

```typescript
// Before
body: JSON.stringify({
  models: ["openai/gpt-4o", "anthropic/claude-opus-4-5", "google/gemini-2.0-flash"],
  route: "fallback",
  messages: [{ role: "user", content: "Summarize this contract." }],
})
```

```typescript
// After
services: {
  llm: {
    providers: ["openai", "anthropic", "gemini"],
    strategy: "failover", // also: "round-robin" | "lowest-latency" | "cheapest" | "weighted" | "geo"
  },
},
```

```typescript
const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
});
```

If you were using OpenRouter primarily for **cost-based routing**, Meridian's `"cheapest"` strategy with a `costs` map does the same thing — see the [multi-provider-llm example](../../examples/multi-provider-llm/index.ts) for `embeddings` routed by `strategy: "cheapest"`.

## 4. Headers you can drop

OpenRouter-specific headers (`HTTP-Referer`, `X-Title` for leaderboard attribution, the single `Authorization: Bearer OPENROUTER_KEY`) go away entirely — each provider is authenticated with its own key in `providers.<name>.auth`, handled by Meridian.

## 5. Cost tracking

OpenRouter reports cost per request via its response `usage` field and a separate `/generation` endpoint. Meridian tracks cost across all configured providers via `meridian.cost()`:

```typescript
const report = meridian.cost("USD");
// { openai: { requests: 412, estimatedCost: 6.18 }, anthropic: { requests: 38, estimatedCost: 0.91 }, ... }
```

## 6. What changes operationally

| | OpenRouter | Meridian |
|---|---|---|
| Where requests go | Your app → OpenRouter → provider | Your app → provider, directly |
| API keys | One OpenRouter key | Your own key per provider |
| Billing | Consolidated through OpenRouter (with markup) | Direct to each provider |
| Availability dependency | Your app + OpenRouter + provider | Your app + provider |
| Non-LLM providers (payments, KYC, comms) | Not covered — separate SDKs needed | Same `provider()`/`service()` pattern, same observability |

## When to keep OpenRouter

If you specifically want access to a long tail of niche/open-source models without managing individual provider accounts, or LLMs are genuinely the *only* third-party dependency your app has, OpenRouter's hosted simplicity may still be the right call. See [Meridian vs. OpenRouter](../comparisons/openrouter.md) for the full breakdown.

## Checklist

- [ ] Create accounts/API keys directly with the providers you actually use (OpenAI, Anthropic, Gemini, ...)
- [ ] Replace the single OpenRouter `fetch` call with `meridian.provider(name)` or `meridian.service("llm")`
- [ ] Convert `model: "<provider>/<model>"` into `providers: { <provider>: {...} }` + body `{ model: "<model>" }`
- [ ] Convert `models: [...] + route: "fallback"` into `services.llm.providers` + `strategy: "failover"`
- [ ] Drop OpenRouter-specific headers (`HTTP-Referer`, `X-Title`)
- [ ] Replace OpenRouter cost dashboards with `meridian.cost()` / `meridian.analytics()`
