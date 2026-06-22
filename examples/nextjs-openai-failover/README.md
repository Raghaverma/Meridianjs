# nextjs-openai-failover

Demonstrates `meridianjs/ai` — Meridian's Vercel AI SDK middleware — inside a
Next.js App Router API route. OpenAI is tried first; if it fails (rate limit,
network error, 5xx), Meridian automatically fails over to Anthropic.

This works because the AI SDK already normalizes every provider into one
`doGenerate`/`doStream` interface — `meridianReliability()` just wraps it with
retries, a circuit breaker, and failover. No request/response translation,
and no application code change between providers.

> **Why not `Meridian.service("llm").post(...)`?** That's Meridian's raw HTTP
> layer, and it deliberately does *not* fail over POST requests — a different
> provider has no way to know whether the original write already happened, so
> replaying it risks a duplicate side effect (e.g. being billed for the same
> generation twice). It also can't translate OpenAI's request/response shape
> into Anthropic's. The AI SDK middleware below sidesteps both problems
> because the AI SDK did the normalization already. See
> [docs/ai-sdk.md](../../docs/ai-sdk.md) and
> [docs/failover/index.md](../../docs/failover/index.md).

## What it demonstrates

- `wrapLanguageModel({ model, middleware: meridianReliability({ fallbacks }) })`
- Automatic failover from OpenAI → Anthropic on retryable errors
- `response.modelId` to observe which vendor actually served the request
- Errors surfacing as a clean 502 once every model (and its retries) is exhausted

## Environment variables

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Setup

```bash
npx create-next-app@latest my-app --typescript --app
cd my-app
npm install meridianjs ai @ai-sdk/openai @ai-sdk/anthropic
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

The response includes an `x-meridian-provider` header so you can see which
backend handled the request — kill your `OPENAI_API_KEY` (or point it at an
invalid key) to watch it fail over to Anthropic.

## File structure

```
app/
  api/
    chat/
      route.ts   ← the only file you need
```
