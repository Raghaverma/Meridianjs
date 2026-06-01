# Quickstart Guide

This guide will help you get started with Meridian SDK and integrate your first normalized provider client.

## Installation

Install the package via npm:

```bash
npm install meridianjs
```

Meridian requires **Node.js ≥ 18** and has **zero runtime dependencies**.

---

## 1. Initialize the Client

Unlike other SDKs, you must instantiate Meridian asynchronously using the static `Meridian.create` method. This allows Meridian to perform any asynchronous initialization steps (e.g., fetching or discovering auth tokens) safely before any requests are made.

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  providers: {
    stripe: {
      auth: { apiKey: process.env.STRIPE_SECRET_KEY }
    },
    razorpay: {
      auth: {
        username: process.env.RAZORPAY_KEY_ID,
        password: process.env.RAZORPAY_KEY_SECRET
      }
    }
  },
  // Set localUnsafe to true when working locally with in-memory breaker/limiter states
  localUnsafe: true 
});
```

---

## 2. Make Your First Request

Once initialized, you can get a provider client using `meridian.provider(name)`. From there, the API operations (`.get()`, `.post()`, `.put()`, `.delete()`) are identical across all providers.

```typescript
// Fetch customers using Stripe
const stripeRes = await meridian.provider("stripe").get("/v1/customers");
console.log(`Provider: ${stripeRes.meta.provider}`);
console.log(`Request ID: ${stripeRes.meta.requestId}`);

// Fetch customers using Razorpay - exactly the same application syntax!
const razorpayRes = await meridian.provider("razorpay").get("/v1/customers");
console.log(`Provider: ${razorpayRes.meta.provider}`);
console.log(`Request ID: ${razorpayRes.meta.requestId}`);
```

---

## 3. Normalized Response Metadata

Every successful request returns a structured `NormalizedResponse` containing two keys:
1. `data`: The raw body response returned by the provider.
2. `meta`: Standardized metadata about the request.

```typescript
interface NormalizedResponse<T = unknown> {
  data: T;
  meta: ResponseMeta;
}

interface ResponseMeta {
  provider: string;        // Lowercase provider identifier (e.g., "stripe")
  requestId: string;       // Unique ID for request tracing
  rateLimit: RateLimitInfo;// Standardized rate-limiting stats
  pagination?: PaginationInfo; // Standardized pagination pointer (if paginated)
  warnings: string[];      // SDK warnings (e.g., schema drift warnings)
  schemaVersion: string;   // API schema contract version
}

interface RateLimitInfo {
  limit: number;           // Max requests allowed in current window
  remaining: number;       // Requests remaining in current window
  reset: Date;             // Expiration timestamp of current window
}
```

---

## 4. Standardized Error Handling

All provider exceptions are wrapped into a single, unified type called `MeridianError`. This allows you to handle rate-limiting, authentication failures, and network timeouts uniformly without writing custom parsing code for each provider.

```typescript
import { MeridianError } from "meridianjs";

try {
  await meridian.provider("stripe").post("/v1/charges", {
    body: { amount: 2000, currency: "usd" }
  });
} catch (error) {
  if (error instanceof MeridianError) {
    console.log(`Category: ${error.category}`); // "auth" | "rate_limit" | "validation" | "network" | "provider"
    console.log(`Retryable? ${error.retryable}`); // true/false
    console.log(`Retry After: ${error.retryAfter}`); // Date | undefined
    console.log(`Original HTTP Status: ${error.status}`);
  }
}
```

Next: Check out [Adapters Guide](adapters.md) to learn how to create your own custom API adapters!
