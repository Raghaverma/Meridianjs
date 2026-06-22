# Vercel AI SDK middleware

`meridianjs/ai` wraps [Vercel AI SDK](https://ai-sdk.dev) language models with
Meridian's retry, circuit-breaker, failover, and observability primitives —
without translating anything. The AI SDK already normalizes every provider
into one `doGenerate`/`doStream` interface, so unlike Meridian's HTTP layer,
no request/response shape conversion is needed here.

## Install

```bash
npm install ai meridianjs
```

`ai` (and its peer `@ai-sdk/provider`) is an optional peer dependency of
`meridianjs` — only required if you import `meridianjs/ai`.

## Usage

```typescript
import { generateText, wrapLanguageModel } from "ai";
import { meridianReliability } from "meridianjs/ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: meridianReliability({
    fallbacks: [anthropic("claude-opus-4-5")],
    retry: { maxRetries: 2, baseDelay: 200 },
  }),
});

const { text } = await generateText({ model, prompt: "Summarize this contract." });
```

If OpenAI is down, this retries against OpenAI per `retry`, then fails over to
Anthropic — automatically, with no per-provider request translation, because
`generateText`/`streamText` already speak the same interface to both models.

## Why failover is safe here (and where it isn't)

Meridian's HTTP layer refuses to fail over a `POST`/`PATCH` — a different
provider has no way to know whether the original write already happened, so
replaying it risks a duplicate side effect (see [docs/failover/index.md](failover/index.md)).
Generation calls don't have that problem: providers bill only for completions
actually **returned**, so a call that errors before producing output can't be
double-charged by retrying it or trying a different model. That's why
`meridianReliability()` defaults to `IdempotencyLevel.SAFE` internally.

What's *not* covered:

- **Mid-stream errors.** `wrapStream` only retries/fails over the `doStream()`
  promise — i.e. failures before any chunk is emitted. Once a stream starts
  emitting parts, a later error propagates to the caller exactly as the
  provider produced it. Silently retrying mid-stream would either duplicate
  output already sent to the caller or require buffering the whole stream,
  which this version doesn't do.
- **Auth and validation errors don't fail over by default.** A bad API key or
  a malformed request is a configuration problem, not an outage — failing
  over would silently mask it instead of surfacing it clearly. Widen this with
  `failoverOn: [..., "auth"]` if you'd rather fail over anyway (e.g. a key
  that's expired specifically on the primary provider).

## Options

```typescript
interface MeridianAiOptions {
  /** Models tried in order if the primary fails. Each gets its own retry + circuit breaker. */
  fallbacks?: LanguageModelV3[];
  /** Retry config shared by every model. Defaults to no retries, matching the core SDK. */
  retry?: { maxRetries?: number; baseDelay?: number; maxDelay?: number; jitter?: boolean };
  /** Circuit breaker config shared by every model. */
  circuitBreaker?: { failureThreshold?: number; successThreshold?: number; timeout?: number; volumeThreshold?: number };
  /** Same ObservabilityAdapter interface as the core SDK — console, OTel, AnalyticsCollector, ReliabilityRecorder all work unmodified. */
  observability?: ObservabilityAdapter[];
  /** Error categories that move to the next fallback model. Defaults to ["rate_limit", "network", "provider"]. */
  failoverOn?: MeridianErrorCategory[];
  /** Override how a thrown error maps to a retry/failover decision. */
  classifyError?: (error: unknown) => { category: MeridianErrorCategory; retryable: boolean };
}
```

## Observability and recording

Pass any `ObservabilityAdapter` — the same interface the core SDK uses for
HTTP calls — to get analytics, console narration, OpenTelemetry spans, or
reliability recordings for AI calls too:

```typescript
import { AnalyticsCollector } from "meridianjs";
import { meridianReliability } from "meridianjs/ai";

const analytics = new AnalyticsCollector();
const middleware = meridianReliability({ observability: [analytics] });

// later
analytics.getHealth(); // includes the AI model providers now
```

## Scope (v1)

- Language models only (`wrapLanguageModel`) — no `EmbeddingModelV3Middleware`
  or `ImageModelV3Middleware` yet.
- Targets the current stable AI SDK major (`ai@^6`, `LanguageModelV3Middleware`).
  Older `ai@5`/V2-middleware projects aren't supported.
- Fallback models must be concrete `LanguageModelV3` instances (e.g.
  `anthropic("claude-opus-4-5")`) — the AI SDK's string-shorthand
  `GlobalProviderModelId` isn't resolved.
