<div align="center">

# Meridian

**One SDK. Every API. Zero inconsistency.**

[![npm version](https://img.shields.io/npm/v/meridianjs?color=0070f3&label=npm)](https://www.npmjs.com/package/meridianjs)
[![npm downloads](https://img.shields.io/npm/dm/meridianjs?color=0070f3)](https://www.npmjs.com/package/meridianjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-1568%20passing-brightgreen)](https://vitest.dev)
[![Adapters](https://img.shields.io/badge/adapters-39-blueviolet)](#provider-status-matrix)

A TypeScript-first SDK that gives every third-party API the same interface — normalized errors, rate limits, pagination, circuit breaking, and automatic failover, regardless of provider.

Zero runtime dependencies. Works in Node.js 18+.

</div>

---

## Install

```bash
npm install meridianjs
```

---

## Quick Start

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe:   { auth: { apiKey: process.env.STRIPE_SECRET_KEY } },
    razorpay: { auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET } },
    openai:   { auth: { apiKey: process.env.OPENAI_API_KEY } },
  },
});

// Every provider returns the same shape
const { data, meta } = await meridian.provider("stripe").get("/v1/customers");

console.log(meta.provider);             // "stripe"
console.log(meta.rateLimit.remaining);  // always normalized
console.log(meta.pagination?.hasNext);  // always normalized
console.log(meta.trace.latency);        // ms, always present
console.log(meta.trace.retries);        // how many retries happened
console.log(meta.trace.circuitBreaker); // "CLOSED" | "OPEN" | "HALF_OPEN"
```

---

## What Meridian Does

| Feature | Without Meridian | With Meridian |
|---|---|---|
| Error handling | Different shape per provider | `MeridianError` — always `category`, `retryable`, `retryAfter` |
| Rate limits | Parse headers manually per provider | `meta.rateLimit` — always normalized |
| Pagination | Different cursor/offset/link per provider | `meta.pagination` — always normalized |
| Retries | Roll your own | Exponential backoff with jitter, idempotency-safe |
| Circuit breaking | Roll your own | Automatic, per-provider |
| Provider outage | Your app breaks | Automatic failover to next provider |
| Request tracing | Nothing | `meta.trace` — latency, retries, circuit state |
| API drift | Silent production breaks | `meridian.schema.check()` — detect before it breaks |

---

## Service Abstraction & Failover

Your application stops knowing which vendor it uses. If OpenAI goes down, Anthropic takes over. No code changes, no deployment.

```typescript
const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:    { auth: { apiKey: process.env.OPENAI_API_KEY } },
    anthropic: { auth: { apiKey: process.env.ANTHROPIC_API_KEY } },
    gemini:    { auth: { apiKey: process.env.GEMINI_API_KEY } },
  },
  services: {
    llm: {
      providers: ["openai", "anthropic", "gemini"],
      strategy: "failover",  // try in order, advance on network/rate/provider errors
    },
    payments: {
      providers: ["stripe", "razorpay"],
      strategy: "highest-success-rate",  // always routes to healthiest provider
    },
    cheapLlm: {
      providers: ["openai", "anthropic", "gemini"],
      strategy: "cheapest",
      costs: { openai: 0.03, anthropic: 0.01, gemini: 0.02 }, // per 1K tokens
    },
  },
});

// Your application never touches provider names again
const result = await meridian.service("llm")!.post("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] },
});
```

**Routing strategies:**

| Strategy | Behaviour |
|---|---|
| `"failover"` | Try providers in order. Advance on `rate_limit`, `network`, or `provider` errors. |
| `"round-robin"` | Distribute requests evenly across all providers. |
| `"lowest-latency"` | Route to the fastest provider. Self-calibrates using EWMA over `meta.trace.latency`. |
| `"cheapest"` | Route to the cheapest provider. Fails over in ascending cost order. |
| `"highest-success-rate"` | Route to the provider with the best live success rate from `meridian.analytics()`. |

---

## Request Trace

Every response carries operational telemetry — no configuration needed:

```typescript
const result = await meridian.provider("stripe").get("/v1/customers");

console.log(result.meta.trace);
// {
//   retries: 2,
//   latency: 341,          // ms end-to-end including retries
//   circuitBreaker: "CLOSED",
//   rateLimitRemaining: 91
// }
```

---

## Analytics & Health

```typescript
// After some traffic has flowed through:
console.log(meridian.analytics());
// {
//   stripe:   { requests: 12431, errors: 37, errorRate: "0.3%", avgLatency: 240, p95Latency: 480 },
//   razorpay: { requests: 8111,  errors: 146, errorRate: "1.8%", avgLatency: 410, p95Latency: 820 },
//   openai:   { requests: 4200,  errors: 50,  errorRate: "1.2%", avgLatency: 780, p95Latency: 1500 }
// }

console.log(meridian.health());
// {
//   stripe:   { status: "healthy",  successRate: "99.7%", avgLatency: 240, circuitBreaker: "CLOSED" },
//   razorpay: { status: "degraded", successRate: "98.2%", avgLatency: 410, circuitBreaker: "CLOSED" },
//   openai:   { status: "down",     successRate: "88.1%", avgLatency: 780, circuitBreaker: "OPEN"   }
// }
```

Health thresholds: `>= 99%` → healthy, `>= 95%` → degraded, `< 95%` → down. Circuit breaker state overrides: `OPEN` → down, `HALF_OPEN` → at least degraded.

---

## Debug Recording & Replay

Record production requests. Replay failures locally.

```typescript
meridian.debug.enable();

// Run your application...

const recordings = meridian.debug.recordings();
// [
//   {
//     requestId: "abc-123",
//     provider: "stripe",
//     endpoint: "/v1/charges",
//     method: "POST",
//     statusCode: 200,
//     duration: 241,
//     trace: { retries: 0, latency: 241, circuitBreaker: "CLOSED", rateLimitRemaining: 99 },
//     options: { method: "POST", body: { amount: 1000, currency: "usd" } }
//   }
// ]

// Replay a specific request with identical options:
const fresh = await meridian.replay("abc-123");

meridian.debug.disable();
meridian.debug.clear();
```

---

## Policy Engine

Block requests before they leave your application. Enforce compliance rules at the SDK layer.

```typescript
import { Meridian, blockPII, allowedProviders, readOnly, customPolicy } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: { openai: { auth: { apiKey: "..." } } },
  policies: [
    // Block PII (credit cards, SSNs, emails, Aadhaar, PAN) from reaching OpenAI
    blockPII(["openai"]),

    // Only allow these providers to be used
    allowedProviders(["openai", "stripe"]),

    // No write operations to GitHub in this service
    readOnly(["github"]),

    // Custom policy with your own logic
    customPolicy("require-tenant-id", (ctx) =>
      ctx.body && typeof ctx.body === "object" && "tenantId" in ctx.body
        ? { allow: true }
        : { allow: false, reason: "tenantId is required in all requests" }
    ),
  ],
});
```

A blocked request throws `MeridianError` with `category: "validation"` containing the policy name and reason. Policies run before the request leaves the process — no network round-trip wasted.

**Built-in policies:**

| Function | Description |
|---|---|
| `blockPII(providers?)` | Detects and blocks credit cards, SSNs, emails, phone numbers, Aadhaar, PAN |
| `allowedProviders(list)` | Only allow requests to the specified providers |
| `blockedProviders(list)` | Block requests to the specified providers entirely |
| `readOnly(providers?)` | Block POST, PUT, PATCH, DELETE |
| `customPolicy(name, fn)` | Define any rule as a function |

---

## Multi-Provider Transactions

Coordinate operations across multiple providers. If any step fails, compensating rollbacks run automatically in reverse order.

```typescript
import { Meridian } from "meridianjs";

const stripe  = meridian.provider("stripe")!;
const sendgrid = meridian.provider("sendgrid")!;
const hubspot  = meridian.provider("hubspot")!;

const result = await meridian.transaction([
  {
    name: "charge",
    execute: async () =>
      stripe.post("/v1/charges", { body: { amount: 2000, currency: "usd", source: "tok_visa" } }),
    rollback: async (r) =>
      stripe.post(`/v1/charges/${(r.data as any).id}/refund`),
  },
  {
    name: "email",
    execute: async () =>
      sendgrid.post("/v3/mail/send", { body: { to: "user@example.com", subject: "Receipt" } }),
    // no rollback — can't unsend an email
  },
  {
    name: "crm",
    execute: async () =>
      hubspot.post("/crm/v3/objects/contacts", { body: { properties: { email: "user@example.com" } } }),
    rollback: async (r) =>
      hubspot.delete(`/crm/v3/objects/contacts/${(r.data as any).id}`),
  },
]);

// { succeeded: ["charge", "email", "crm"], rolledBack: [], results: {...} }
```

If `crm` fails: charge is refunded, `email` has no rollback (skipped), and `TransactionError` is thrown with `failed`, `succeeded`, `rolledBack`, `rollbackErrors`, and partial `results`.

---

## Schema Drift Detection

Snapshot API response schemas and get alerted when providers silently rename or remove fields.

```typescript
// Baseline today's response:
const customers = await meridian.provider("stripe")!.get("/v1/customers");
await meridian.schema.snapshot("stripe", "/v1/customers", customers.data);

// Run again tomorrow (or in CI):
const latest = await meridian.provider("stripe")!.get("/v1/customers");
const drifts = await meridian.schema.check("stripe", "/v1/customers", latest.data);

if (drifts.length > 0) {
  console.error("Stripe API drift detected:");
  for (const d of drifts) {
    console.error(`  ${d.severity} ${d.type}: field "${d.field}" changed from ${d.oldValue} → ${d.newValue}`);
  }
}
// ERROR FIELD_REMOVED: field "customer_name" changed from "string" → undefined
// WARNING REQUIRED_REMOVED: field "name" changed from true → false
```

Schemas are stored by default in `.meridian/schemas/` (file system). Configure a custom `SchemaStorage` for cloud storage or databases.

---

## Provider Capability Registry

Discover what each provider supports. Build capability-driven routing.

```typescript
meridian.providers();
// [
//   { name: "openai",    capabilities: ["chat", "completions", "embeddings", "streaming", "vision", ...] },
//   { name: "stripe",    capabilities: ["payments", "subscriptions", "refunds", "invoices", ...] },
//   { name: "razorpay",  capabilities: ["payments", "upi", "subscriptions", "refunds", ...] },
// ]

meridian.findProviders({ capability: "streaming" });
// [{ name: "openai", ... }, { name: "anthropic", ... }, { name: "gemini", ... }, { name: "mistral", ... }]

meridian.findProviders({ capability: "kyc" });
// [{ name: "hyperverge", ... }, { name: "digio", ... }, { name: "karza", ... }, { name: "idfy", ... }]

meridian.findProviders({ capability: "upi" });
// [{ name: "razorpay", ... }, { name: "phonepe", ... }, { name: "cashfree", ... }, { name: "setu", ... }]
```

Custom adapters can declare additional capabilities via the optional `capabilities(): string[]` method.

---

## Adapter Generator

Scaffold a new provider adapter in under a minute.

```bash
# From a description:
npx meridian generate --provider acme --base-url https://api.acme.com --auth bearer

# From an OpenAPI 3.x spec:
npx meridian generate --provider acme --openapi ./acme-openapi.json
```

Generates four files in `src/providers/acme/`:

| File | Contents |
|---|---|
| `adapter.ts` | Full working adapter with auth, error mapping, rate-limit header parsing |
| `adapter.test.ts` | 8 tests that pass immediately |
| `pagination.ts` | Cursor pagination stub with TODO comments |
| `index.ts` | Barrel export |

**Options:**

| Flag | Description | Default |
|---|---|---|
| `--provider` | Provider name (required) | — |
| `--openapi` | Path to OpenAPI 3.x JSON file | — |
| `--base-url` | API base URL | `https://api.<name>.com` |
| `--auth` | Auth type: `apiKey`, `bearer`, `basic`, `oauth2` | `apiKey` |
| `--output` | Output directory | `src/providers/<name>/` |

---

## Error Handling

Every provider error has the same shape — no more per-provider archaeology:

```typescript
try {
  const result = await meridian.provider("stripe")!.post("/v1/charges", { body });
} catch (err) {
  if (err instanceof MeridianError) {
    err.category;   // "auth" | "rate_limit" | "validation" | "network" | "provider"
    err.code;       // "AUTH_FAILED" | "RATE_LIMITED" | "BAD_REQUEST" | "UPSTREAM_5XX" | ...
    err.retryable;  // boolean — safe to retry?
    err.retryAfter; // Date | undefined — when to retry
    err.provider;   // "stripe"
    err.requestId;  // for support tickets
  }
}
```

---

## Circuit Breaker

Each provider has its own circuit breaker. Opens after repeated failures, probes with a single request after a timeout, closes on success.

```typescript
const status = meridian.getCircuitStatus("stripe");
// {
//   state: "CLOSED",    // "CLOSED" | "OPEN" | "HALF_OPEN"
//   failures: 0,
//   successes: 12,
//   lastFailure: null,
//   nextAttempt: null
// }
```

---

## Pagination

```typescript
for await (const page of meridian.provider("stripe")!.paginate("/v1/customers")) {
  console.log(page.meta.pagination);
  // { hasNext: true, cursor: "cu_next123", total: 4200 }
  for (const customer of page.data as Customer[]) {
    process(customer);
  }
}
```

Works identically for cursor, offset, and link-header pagination — the adapter handles the translation.

---

## Streaming

```typescript
for await (const chunk of meridian.provider("openai")!.stream("/v1/chat/completions", {
  body: { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }], stream: true },
})) {
  process.stdout.write(chunk.data as string);
}
```

Supported: OpenAI, Anthropic, Gemini, Mistral, Cohere.

---

## Batch Requests

```typescript
const results = await meridian.provider("stripe")!.batch([
  { method: "GET", endpoint: "/v1/customers/cu_1" },
  { method: "GET", endpoint: "/v1/customers/cu_2" },
  { method: "GET", endpoint: "/v1/customers/cu_3" },
], 5); // max 5 concurrent

// Results always in input order. Errors are MeridianError, never thrown.
```

---

## Webhook Verification

```typescript
import { StripeAdapter } from "meridianjs";

const adapter = new StripeAdapter();
const valid = adapter.verifyWebhook(
  req.rawBody,
  req.headers["stripe-signature"],
  process.env.STRIPE_WEBHOOK_SECRET,
);
```

Timing-safe HMAC verification available on Stripe, Razorpay, Cashfree, Braintree, Twilio, Adyen, and more.

---

## Configuration Reference

```typescript
const meridian = await Meridian.create({
  // Required: either localUnsafe:true or stateStorage
  localUnsafe: true,                     // dev only — warns on startup

  // Per-provider configuration
  providers: {
    stripe: {
      auth: { apiKey: "sk_live_..." },   // or token, username/password, clientId/Secret
      baseUrl: "https://api.stripe.com", // override base URL
      retry: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, jitter: true },
      circuitBreaker: { failureThreshold: 5, timeout: 60000, errorThresholdPercentage: 50 },
      rateLimit: { tokensPerSecond: 10, maxTokens: 100, adaptiveBackoff: true },
    },
  },

  // Service abstraction — group providers behind a logical name
  services: {
    llm: { providers: ["openai", "anthropic"], strategy: "failover" },
  },

  // Default settings applied to all providers
  defaults: {
    timeout: 30000,
    retry: { maxRetries: 2 },
    circuitBreaker: { failureThreshold: 5 },
  },

  // Policy engine
  policies: [blockPII(["openai"]), readOnly(["github"])],

  // Observability (any number of adapters)
  observability: [new ConsoleObservability(), new PrometheusObservability()],

  // Distributed state (required for multi-instance deployments)
  mode: "distributed",
  stateStorage: new RedisStateStorage(redisClient),

  // Schema validation & drift detection
  schemaValidation: {
    enabled: true,
    storage: new FileSystemSchemaStorage(".meridian/schemas"),
    onDrift: (drifts) => alerting.notify(drifts),
  },

  // Compliance
  compliance: {
    piiRedaction: true,   // redacts Aadhaar, PAN, bank accounts from logs
    indiaMode: true,      // DPDPA-compliant redaction
    auditLog: true,
  },

  // Idempotency
  idempotency: {
    defaultLevel: IdempotencyLevel.SAFE,
    autoGenerateKeys: true,
  },
});
```

---

## Provider Status Matrix

Every adapter passes a 19-invariant contract test suite before being listed. Run the suite yourself:

```bash
npm run test:contracts          # all 39 adapters
npm run test:contracts stripe   # single provider
```

| Provider | Category | Contract | Status |
|:---|:---|:---:|:---:|
| **Adyen** | Payments | 19/19 | ✅ |
| **Anthropic** | AI / LLM | 19/19 | ✅ |
| **Apollo.io** | CRM / Sales | 19/19 | ✅ |
| **Auth0** | Auth / Identity | 19/19 | ✅ |
| **Braintree** | Payments | 19/19 | ✅ |
| **Cashfree** | Payments | 19/19 | ✅ |
| **Checkout.com** | Payments | 19/19 | ✅ |
| **Cleartax** | Tax / Compliance | 19/19 | ✅ |
| **Cohere** | AI / LLM | 19/19 | ✅ |
| **Decentro** | Banking / Fintech | 19/19 | ✅ |
| **Delhivery** | Logistics | 19/19 | ✅ |
| **Digio** | eSign / KYC | 19/19 | ✅ |
| **Exotel** | Communications | 19/19 | ✅ |
| **Google Gemini** | AI / LLM | 19/19 | ✅ |
| **GitHub** | Developer Tools | 19/19 | ✅ |
| **Gupshup** | Communications | 19/19 | ✅ |
| **HubSpot** | CRM | 19/19 | ✅ |
| **HyperVerge** | KYC / Identity | 19/19 | ✅ |
| **IDfy** | KYC / Identity | 19/19 | ✅ |
| **Juspay** | Payments | 19/19 | ✅ |
| **Karza** | KYC / Verification | 19/19 | ✅ |
| **Klarna** | Payments | 19/19 | ✅ |
| **Mailgun** | Communications | 19/19 | ✅ |
| **MapMyIndia** | Maps / Geo | 19/19 | ✅ |
| **Mistral** | AI / LLM | 19/19 | ✅ |
| **Mollie** | Payments | 19/19 | ✅ |
| **MSG91** | Communications | 19/19 | ✅ |
| **OpenAI** | AI / LLM | 19/19 | ✅ |
| **PayU** | Payments | 19/19 | ✅ |
| **Perfios** | Financial Data | 19/19 | ✅ |
| **PhonePe** | Payments | 19/19 | ✅ |
| **Razorpay** | Payments | 19/19 | ✅ |
| **SendGrid** | Communications | 19/19 | ✅ |
| **Setu** | Banking / UPI | 19/19 | ✅ |
| **Shiprocket** | Logistics | 19/19 | ✅ |
| **Stripe** | Payments | 19/19 | ✅ |
| **Supabase** | Database / Auth | 19/19 | ✅ |
| **Twilio** | Communications | 19/19 | ✅ |
| **Vonage** | Communications | 19/19 | ✅ |

---

## Adding a Provider

Fastest path: use the generator.

```bash
npx meridian generate --provider myprovider --openapi ./myprovider-openapi.json
```

Manual path: implement `ProviderAdapter` and register it:

```typescript
import type { ProviderAdapter } from "meridianjs";

class MyAdapter implements ProviderAdapter {
  buildRequest(input) { ... }
  parseResponse(raw)  { ... }
  parseError(raw)     { ... }
  authStrategy(cfg)   { ... }
  rateLimitPolicy(h)  { ... }
  paginationStrategy(){ ... }
  getIdempotencyConfig() { ... }
}

await meridian.registerProvider("myprovider", new MyAdapter(), {
  auth: { apiKey: process.env.MY_API_KEY },
});
```

---

## Contributing

1. Fork → feature branch → PR
2. Every new adapter requires: `adapter.ts`, `adapter.test.ts`, `pagination.ts`, `index.ts`
3. All existing contract tests must continue to pass: `npm test`
4. The adapter generator produces a correct starting point: `npx meridian generate --provider yourprovider`

---

## Links

- [Changelog](CHANGELOG.md)
- [License: MIT](LICENSE.md)
- [npm](https://www.npmjs.com/package/meridianjs)
