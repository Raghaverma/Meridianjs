# Migrating from the OpenAI SDK to Meridian

This guide walks through converting an app that calls `openai` directly into one that calls Meridian instead. The request and response **bodies stay the same** — `data` is the same JSON OpenAI would have returned. What changes is how you call the API and what you get back alongside `data`.

You don't have to migrate everything at once. Meridian wraps `https://api.openai.com` directly, so you can move one call site at a time and run both side by side while you do.

## 1. Install and initialize

```diff
- npm install openai
+ npm install meridianjs
```

```typescript
// Before
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

```typescript
// After
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true, // single instance / local dev — see note below
  providers: {
    openai: { auth: { apiKey: process.env.OPENAI_API_KEY } },
  },
});

const openai = meridian.provider("openai")!;
```

`Meridian.create` is async (it resolves auth and warms up internal state), so it typically lives in your app's bootstrap/startup code, not inside a request handler. `localUnsafe: true` keeps rate-limit and circuit-breaker state in memory — fine for local dev or a single instance. For multi-instance/serverless deployments, see [Shared State Persistence](../upgrade-guide.md#2-shared-state-persistence-distributed-mode).

## 2. Chat completions

The OpenAI SDK gives you a typed `.chat.completions.create()` method. Meridian gives you `.post()` against the same REST endpoint OpenAI's SDK calls under the hood — so the request body is identical, and `data` is OpenAI's response, unchanged.

```typescript
// Before
const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Summarize this contract." }],
});
const reply = completion.choices[0].message.content;
```

```typescript
// After
const { data, meta } = await openai.post("/v1/chat/completions", {
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Summarize this contract." }],
  },
});
const reply = data.choices[0].message.content;

// New: request tracing, rate limits, retries — for free
console.log(meta.requestId, meta.rateLimit.remaining, meta.trace.retries);
```

## 3. Streaming

The OpenAI SDK's `stream: true` option returns an async iterable of typed chunks. Meridian's `.stream()` returns an `AsyncGenerator<StreamChunk<T>>` over the same SSE response — `chunk.data` is OpenAI's chunk JSON.

```typescript
// Before
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Write a haiku." }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

```typescript
// After
const stream = openai.stream("/v1/chat/completions", {
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Write a haiku." }],
    stream: true,
  },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.data?.choices?.[0]?.delta?.content ?? "");
}
```

## 4. Embeddings and other endpoints

Any OpenAI REST endpoint works the same way — there's no separate "embeddings client," just a different path:

```typescript
// Before
const { data } = await openai.embeddings.create({ model: "text-embedding-3-small", input: "hello world" });

// After
const { data } = await openai.post("/v1/embeddings", {
  body: { model: "text-embedding-3-small", input: "hello world" },
});
```

## 5. Error handling

The OpenAI SDK throws `APIError` subclasses (`RateLimitError`, `AuthenticationError`, `APIConnectionError`, ...) that you check with `instanceof` or `error.status`. Meridian normalizes all of these into one `MeridianError`:

```typescript
// Before
import OpenAI from "openai";

try {
  await openai.chat.completions.create({ /* ... */ });
} catch (err) {
  if (err instanceof OpenAI.RateLimitError) {
    // back off and retry
  } else if (err instanceof OpenAI.AuthenticationError) {
    // bad API key
  }
  throw err;
}
```

```typescript
// After
import { MeridianError } from "meridianjs";

try {
  await openai.post("/v1/chat/completions", { body: { /* ... */ } });
} catch (err) {
  if (err instanceof MeridianError) {
    console.log(err.category);    // "rate_limit" | "auth" | "network" | "validation" | "provider"
    console.log(err.retryable);   // true/false — Meridian already retried internally if it could
    console.log(err.retryAfter);  // Date | undefined
  }
  throw err;
}
```

Meridian retries retryable errors (with exponential backoff) before throwing, so most of the manual retry/backoff loops people write around the OpenAI SDK can simply be deleted.

## 6. The actual reason to migrate: failover

The OpenAI SDK only talks to OpenAI. If OpenAI is down or rate-limiting you, you're down too — unless you hand-write a fallback to Anthropic or Gemini with a *different* request/response shape. Meridian lets you configure a `service("llm")` that fails over automatically, with the **same call you already wrote**:

```typescript
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

// Same shape as Step 2 — but now tries Anthropic if OpenAI's circuit breaker is open
const { data, meta } = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Summarize this contract." }] },
});

console.log(meta.trace.provider); // "openai" or "anthropic" — whichever actually responded
```

See [LLMs](../llms/index.md) for routing strategies (`failover`, `round-robin`, `lowest-latency`, `cheapest`, `weighted`, `geo`) and [Meridian vs. OpenRouter](../comparisons/openrouter.md) if you're considering a hosted router instead.

## What you keep from the OpenAI SDK

- **File uploads, Assistants API, beta/SDK-specific helpers** — Meridian wraps the REST surface generically via `.get/.post/.put/.patch/.delete`, so very new or SDK-specific helper methods may not have a 1:1 equivalent yet. You can keep using `openai` directly for those calls and Meridian for the rest; they don't conflict.
- **Model names, request bodies, response shapes** — all unchanged. There's no new schema to learn for the data itself.

## Checklist

- [ ] Replace `new OpenAI({ apiKey })` with `Meridian.create({ providers: { openai: { auth: { apiKey } } } })`
- [ ] Replace `openai.chat.completions.create(body)` with `meridian.provider("openai").post("/v1/chat/completions", { body })`
- [ ] Replace `instanceof OpenAI.XError` checks with `instanceof MeridianError` + `error.category`
- [ ] Delete hand-rolled retry/backoff loops (Meridian retries internally)
- [ ] Optional: add Anthropic/Gemini and a `service("llm")` for automatic failover
