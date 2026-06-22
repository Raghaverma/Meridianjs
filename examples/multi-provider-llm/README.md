# multi-provider-llm

Node.js script that showcases multi-provider orchestration: chat with real
OpenAI → Anthropic failover via `meridianjs/ai`, embeddings from the cheapest
available provider via Meridian's HTTP service layer, schema drift detection,
and analytics across both.

## What it demonstrates

- `meridianjs/ai`'s `meridianReliability()` — real OpenAI → Anthropic chat
  failover (the AI SDK already normalizes both providers into one interface,
  so no request/response translation is needed, and failover is safe even
  though chat completions are writes — see [docs/ai-sdk.md](../../docs/ai-sdk.md))
- `service("embeddings")` cheapest-cost routing: OpenAI ($0.0001) vs Cohere ($0.00002)
- `SchemaMonitor` drift detection on the embeddings response — alerts if the shape changes
- `meridian.analytics()` for the HTTP layer and a standalone `AnalyticsCollector`
  for the AI SDK layer — same `ObservabilityAdapter` interface, two different
  request paths

> Why not `meridian.service("llm").post(...)` for chat too? That's Meridian's
> raw HTTP layer, and it deliberately never fails over a POST — a different
> provider has no way to know whether the original write already happened.
> It also can't translate OpenAI's request/response shape into Anthropic's.
> See [docs/failover/index.md](../../docs/failover/index.md).

## Environment variables

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
COHERE_API_KEY=...
```

## Setup

```bash
npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic
npm install -D tsx @types/node
```

Run:

```bash
npx tsx index.ts
```

## What you'll see

```
=== Chat (meridianjs/ai, OpenAI -> Anthropic on failure) ===
[chat] provider=gpt-4o-2024-08-06
Reply: TypeScript is a statically typed superset of JavaScript...
[chat] provider=gpt-4o-2024-08-06
Reply: Three benefits of an SDK abstraction layer are...

=== Embeddings (meridian.service, cheapest-cost routing) ===
[embed] provider=cohere latency=98ms
[schema] no drift detected
  "integration reliability" -> length=1024, first=[0.012, -0.034, 0.056]
[embed] provider=cohere latency=91ms
[schema] no drift detected
  "third-party API failover" -> length=1024, first=[0.021, -0.018, 0.044]

=== Analytics: HTTP services (embeddings) ===
  cohere:  { requests: 2, successRate: "100.0%", avgLatency: 95 }

=== Analytics: AI SDK middleware (chat) ===
  openai:  { requests: 2, successRate: "100.0%", avgLatency: 300 }
```
