# Meridian Provider Swapping Example

This example demonstrates Meridian's most powerful developer feature: **the ability to swap underlying third-party API providers with zero changes to downstream application code.**

In this demonstration, we swap the payment infrastructure from **Stripe** to **Razorpay** and show that the response formats, pagination iteration loops, and error/rate-limiting handling logic remain exactly identical.

---

## What is Demonstrated?

1. **Normalized Response Contracts**: Creating customers on Stripe and Razorpay returns a consistent `{ data, meta }` response shape.
2. **Unified Pagination Parsing**: Traversing lists of transactions utilizes the same loop structure, even though Stripe and Razorpay have completely different pagination mechanisms underneath.
3. **Canonical Error Categorization**: Simulated HTTP 429 rate limit responses from both providers are captured as the exact same `MeridianError` class with `category: "rate_limit"`, enabling a single unified error handling strategy.

---

## How to Run

You can run the example locally using the package script (which builds the TypeScript and executes the generated JavaScript offline using Meridian's built-in `MockAdapter` utility):

```bash
npm run example:swap
```
