# nextjs-openai-failover

Demonstrates Meridian's LLM service abstraction inside a Next.js 14 App Router API route.
OpenAI is tried first; if it fails (rate limit, network error, 5xx), Meridian automatically
retries the same request against Anthropic — no application code changes required.

## What it demonstrates

- `Meridian.service("llm")` — vendor-agnostic LLM calls
- Automatic failover from OpenAI → Anthropic
- `meta.provider` to observe which vendor actually served the request
- Streaming passthrough when the provider returns an SSE stream
- `MeridianError` typed error handling in an API route

## Environment variables

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Setup

```bash
npx create-next-app@14 my-app --typescript --app
cd my-app
npm install meridianjs
```

Copy `app/api/chat/route.ts` into your project, add the env vars, then run:

```bash
npm run dev
```

## Usage

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain async/await in one sentence."}'
```

The response includes a `x-meridian-provider` header so you can see which
backend handled the request.

## File structure

```
app/
  api/
    chat/
      route.ts   ← the only file you need
```
