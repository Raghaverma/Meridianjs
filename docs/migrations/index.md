# Migration Guides

Practical, code-level guides for moving an existing integration onto Meridian. Each guide assumes you're keeping most of your application as-is and swapping out one dependency at a time — none of these require a big-bang rewrite.

- **[From the OpenAI SDK](from-openai-sdk.md)** — chat completions, streaming, embeddings, error handling, and adding Anthropic/Gemini failover.
- **[From the Stripe SDK](from-stripe-sdk.md)** — resource calls, idempotency keys, pagination, error handling, webhook verification, and adding Razorpay/Cashfree failover.
- **[From OpenRouter](from-openrouter.md)** — mapping `model: "<provider>/<model>"` and fallback lists onto Meridian's `service("llm")`, with your own provider keys and no extra hop.
- **[From LangChain](from-langchain.md)** — replace LangChain's LLM client entirely, or keep your chains/agents and swap in Meridian as the underlying transport.

## Looking for something else?

- Upgrading an existing Meridian app between SDK versions? See the [Upgrade Guide](../upgrade-guide.md).
- Not sure if Meridian fits your stack at all? See [What is Meridian?](../what-is-meridian.md) and the [comparisons](../comparisons/index.md).
