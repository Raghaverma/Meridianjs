# multi-provider-llm

Node.js script that showcases multi-provider LLM orchestration: chat with
OpenAI/Anthropic failover, embeddings from the cheapest available provider,
schema drift detection on responses, and post-run analytics.

## What it demonstrates

- `service("llm")` failover across OpenAI → Anthropic
- `service("embeddings")` cheapest-cost routing: OpenAI ($0.0001) vs Cohere ($0.00002)
- `meta.provider` and `meta.trace` logged for every call
- `SchemaMonitor` drift detection — alerts if the response shape changes
- `meridian.analytics()` summary after multiple calls

## Environment variables

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
COHERE_API_KEY=...
```

## Setup

```bash
npm install meridianjs
npm install -D tsx @types/node
```

Run:

```bash
npx tsx index.ts
```

## What you'll see

```
[chat] provider=openai  latency=312ms  retries=0
[chat] provider=openai  latency=289ms  retries=0
[embed] provider=cohere latency=98ms   retries=0
Schema drift check: no drift detected
--- Analytics ---
openai:  { requests: 2, successRate: "100.0%", avgLatency: 300 }
cohere:  { requests: 1, successRate: "100.0%", avgLatency: 98 }
```
