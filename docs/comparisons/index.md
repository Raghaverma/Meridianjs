# Meridian vs. Everything Else

If you landed on this repo, you're probably asking one question:

> Why would I use Meridian instead of just calling OpenAI, Stripe, or Razorpay directly?

Here's the 30-second answer.

```
Application
    ↓
Meridian
    ↓
OpenAI · Anthropic · Stripe · Razorpay · Twilio · ...45 providers
```

Meridian is a **reliability layer** that sits between your application and every third-party API you depend on. Your code calls one consistent interface — `provider("stripe")` or `service("payments")` — and Meridian handles retries, circuit breakers, failover, rate limits, pagination, schema drift detection, and observability **the same way for every provider**.

It is not a replacement for provider SDKs. It's the layer that makes depending on *any* of them survivable.

For the full positioning breakdown — what Meridian is, what it deliberately isn't, and the three questions that define a "reliability layer" — see [What is Meridian?](../what-is-meridian.md)

## Pick your comparison

- **[Meridian vs. Raw SDKs](raw-sdks.md)** — what you give up by calling `openai`, `stripe`, `razorpay`, etc. directly, and what Meridian adds without taking anything away.
- **[Meridian vs. LangChain](langchain.md)** — different layers of the stack. LangChain orchestrates LLM applications; Meridian keeps the calls underneath them alive.
- **[Meridian vs. OpenRouter](openrouter.md)** — OpenRouter unifies LLM routing. Meridian unifies LLM routing *and* payments, KYC, communications, and 40+ other providers, in-process, with no extra network hop.
- **[Meridian vs. API Gateways](api-gateways.md)** — gateways manage traffic *into* your services. Meridian manages traffic *out* to third-party APIs — a different direction entirely.

## The short version

| | Raw SDKs | LangChain | OpenRouter | API Gateways | **Meridian** |
|---|---|---|---|---|---|
| Unified error format | ❌ | ❌ | Partial (LLM only) | ❌ | ✅ |
| Automatic retries & circuit breakers | ❌ | ❌ | Partial (LLM only) | Partial (inbound only) | ✅ |
| Multi-provider failover | ❌ | Partial (manual chains) | ✅ (LLM only) | ❌ | ✅ (any provider) |
| Schema drift detection | ❌ | ❌ | ❌ | ❌ | ✅ |
| Beyond LLMs (payments, KYC, comms, logistics) | — | ❌ | ❌ | — | ✅ |
| Runs in-process (no extra network hop) | ✅ | ✅ | ❌ (hosted proxy) | ❌ (separate infra) | ✅ |
| Vendor-agnostic application code | ❌ | ❌ | Partial | — | ✅ |

If you only read one comparison, read [Raw SDKs](raw-sdks.md) — it's the default most teams are coming from.

## Ready to switch?

Once you've picked a comparison, the [migration guides](../migrations/index.md) walk through the actual code changes: [from the OpenAI SDK](../migrations/from-openai-sdk.md), [from the Stripe SDK](../migrations/from-stripe-sdk.md), [from OpenRouter](../migrations/from-openrouter.md), and [from LangChain](../migrations/from-langchain.md).
