# What is Meridian?

Meridian is a **reliability layer** for the third-party APIs your application depends on.

```
Application
    ↓
Meridian
    ↓
OpenAI · Anthropic · Stripe · Razorpay · Twilio · ...46 providers
```

Every call your code makes to an external API — an LLM completion, a payment charge, an SMS send — passes through Meridian first. Meridian normalizes the request and response, retries transient failures, breaks the circuit on a dead provider, fails over to a backup, watches for the provider silently changing its API shape, and records a trace of what happened. Your application code stays the same regardless of which provider is behind it, or whether that provider is healthy right now.

This document exists to answer one question precisely: **what category of tool is this?** It's the foundation every other doc, comparison, and positioning page builds on.

---

## What Meridian is not

### Not an API Wrapper ❌

A wrapper converts one provider's HTTP API into a typed client — `stripe.customers.create(...)` instead of `fetch("https://api.stripe.com/...")`. That's necessary, but it's table stakes. A wrapper around OpenAI doesn't know anything about Stripe, doesn't retry consistently, and has no concept of "if this provider is down, try a different one."

Meridian *contains* 45 adapters that do this wrapping — but the adapters are the substrate, not the product. The product is what happens *uniformly across all 45* when something goes wrong.

### Not an API Gateway ❌

API gateways (Kong, Apigee, AWS API Gateway) sit in front of *your* services and manage traffic coming **in** from clients — auth, rate limiting, routing to the right backend.

Meridian sits *inside* your application and manages traffic going **out** to third-party APIs. It's the same vocabulary (rate limits, policies, routing) applied to the opposite direction of traffic. See [Meridian vs. API Gateways](comparisons/api-gateways.md).

### Not an Integration Platform (iPaaS) ❌

Tools like Zapier, Workato, or Mulesoft let non-engineers wire SaaS apps together through a UI — "when a row is added to this sheet, send a Slack message." They're workflow automation platforms, running on their own schedule, outside your application.

Meridian is a library your application imports and calls **on every request, in the hot path**. There's no separate platform, no UI, no workflows to configure — just `npm install meridianjs` and a config object.

---

## A Reliability Layer ✅

Three questions distinguish a reliability layer from the categories above. Meridian answers yes to all three:

1. **Does it run in-process, in your application's request path?**
   Yes — it's an npm package with zero runtime dependencies. No separate infrastructure, no extra network hop, your API keys never leave your process.

2. **Does it make every provider behave the same way under failure?**
   Yes — every adapter passes the same 19 contract invariants. `MeridianError` always has `category`, `retryable`, `retryAfter`. Retries, circuit breakers, and failover work identically whether the provider is OpenAI, Stripe, or Twilio.

3. **Does it detect when a provider's contract changes, before your code finds out the hard way?**
   Yes — `meridian.schema.check()` snapshots response shapes and flags `FIELD_REMOVED` / `TYPE_CHANGED` drift before it reaches production.

A wrapper fails (2) and (3): each provider SDK handles failure (or doesn't) on its own terms, and none of them watch for upstream contract drift. A gateway fails (1): it's the wrong direction of traffic entirely. An iPaaS tool fails (1): it's a separate platform, not code running in your request path.

---

## What "reliability layer" means concretely

Seven capabilities make this more than a normalization library:

| Capability | What it does |
|---|---|
| **Service abstraction** — `service("llm")` | Your code calls a role (`"llm"`, `"payments"`), not a vendor (`"openai"`, `"stripe"`). Meridian decides which provider handles each request. |
| **Automatic failover** | When the active provider errors, Meridian retries the same request against the next provider in the service — same call, no app-level branching. |
| **Circuit breakers** | After repeated failures, Meridian stops calling a dead provider entirely and fails fast — until it recovers. |
| **Policy engine** | Runs before every request: block PII, redact fields, enforce region rules, restrict to read-only — without a network round-trip. |
| **Schema drift detection** | Snapshots response shapes per provider/endpoint and flags silent breaking changes before they hit production. |
| **Contract testing** | Every adapter — all 45 — passes the same invariant suite, so "Stripe" and "Razorpay" are interchangeable from your application's point of view. |
| **Reliability benchmarks** | `npm run benchmark` proves the claims above against the live pipeline — failover recovery time, circuit breaker fail-fast latency, retry success — and doubles as a CI gate. |

Each of these is useless in isolation. Together, they're the difference between "my app calls OpenAI" and "my app calls an LLM, and OpenAI being down is Meridian's problem, not an incident."

---

## The one-sentence version

**Meridian is the layer that makes depending on third-party APIs survivable.**

## Where to go next

- New to Meridian? Start with the [Quickstart](quickstart.md).
- Wondering why not just use the provider SDK, LangChain, OpenRouter, or a gateway? See [Comparisons](comparisons/index.md).
- Want to see the failure modes above in action? Run `npm run demo:failover`, `demo:circuit-breaker`, `demo:schema-drift`, or `demo:service-routing`.
- Want proof, not just claims? Run `npm run benchmark`.
