# Policies

Enforce governance rules — PII blocking, field requirements, geo restrictions — on every API call at the SDK layer.

## Problem

Without a policy layer, any developer can accidentally ship user PII to an OpenAI prompt, call a sanctioned-country API, or forget to attach a `tenantId` on a multi-tenant request. Compliance teams write rules in Notion docs; engineers don't read them until something breaks in prod.

## Without Meridian

```typescript
// Policy logic scattered across every call site — easy to miss
async function callOpenAI(prompt: string, tenantId?: string) {
  if (!tenantId) throw new Error("tenantId required"); // maybe
  if (/\d{3}-\d{2}-\d{4}/.test(prompt)) throw new Error("SSN detected"); // regex, fragile

  return await openai.chat.completions.create({ ... });
}
// No enforcement on Anthropic calls, Stripe calls, or any other provider.
```

## With Meridian

Policies are declared once at initialization and applied to every matching call automatically.

**blockPII** — reject requests where the body contains detected PII before they leave your network:
```typescript
import { blockPII } from "meridianjs";
policies: [blockPII(["openai", "anthropic", "gemini"])]
```

**redact** — strip specific fields from request bodies before sending:
```typescript
import { redact } from "meridianjs";
policies: [redact(["user.ssn", "card.number", "user.dob"])]
```

**requireFields** — reject requests missing mandatory fields:
```typescript
import { requireFields } from "meridianjs";
policies: [requireFields(["tenantId", "requestId"])]
```

**denyCountries** — block requests originating from or targeting sanctioned countries:
```typescript
import { denyCountries } from "meridianjs";
policies: [denyCountries(["KP", "IR", "CU", "SY"])]
```

**allowedProviders** — whitelist which providers can be called at all:
```typescript
import { allowedProviders } from "meridianjs";
policies: [allowedProviders(["openai", "stripe", "sendgrid"])]
```

**readOnly** — prevent write operations (POST/PUT/PATCH/DELETE) to specific providers:
```typescript
import { readOnly } from "meridianjs";
policies: [readOnly(["github", "jira"])]
```

**customPolicy** — arbitrary logic, same enforcement guarantees:
```typescript
import { customPolicy } from "meridianjs";
policies: [
  customPolicy("require-tenant", (ctx) =>
    "tenantId" in (ctx.body as object)
      ? { allow: true }
      : { allow: false, reason: "tenantId required on all requests" }
  ),
]
```

## Production Example

Fintech compliance setup: block PII to AI providers, require tenantId, deny sanctioned countries, redact card data:

```typescript
import {
  Meridian,
  blockPII,
  redact,
  requireFields,
  denyCountries,
  allowedProviders,
  readOnly,
  customPolicy,
} from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    openai:  { baseUrl: "https://api.openai.com",  auth: { type: "bearer", token: process.env.OPENAI_KEY! } },
    stripe:  { baseUrl: "https://api.stripe.com",  auth: { type: "bearer", token: process.env.STRIPE_KEY! } },
    github:  { baseUrl: "https://api.github.com",  auth: { type: "bearer", token: process.env.GITHUB_TOKEN! } },
  },
  services: {
    llm:      { providers: ["openai"],  strategy: "failover" },
    payments: { providers: ["stripe"],  strategy: "failover" },
  },
  policies: [
    // Never send PII to any LLM provider
    blockPII(["openai", "anthropic", "gemini"]),

    // Scrub card numbers and SSNs from all outgoing request bodies
    redact(["card.number", "card.cvv", "user.ssn", "user.pan"]),

    // Every request must carry tenantId for audit trails
    requireFields(["tenantId"]),

    // OFAC / sanctions compliance — no calls to/from these countries
    denyCountries(["KP", "IR", "CU", "SY", "SD"]),

    // Restrict which providers this instance can reach at all
    allowedProviders(["openai", "stripe", "github"]),

    // GitHub integration is read-only — no accidental writes
    readOnly(["github"]),

    // Custom: require explicit consent flag on any AI call
    customPolicy("ai-consent-required", (ctx) => {
      if (!["openai", "anthropic", "gemini"].includes(ctx.provider)) return { allow: true };
      const body = ctx.body as Record<string, unknown>;
      return body.consentGiven === true
        ? { allow: true }
        : { allow: false, reason: "AI calls require explicit user consent (consentGiven: true)" };
    }),
  ],
});

// This will throw — SSN detected, tenantId missing, no consent
await meridian.provider("openai")!.post("/v1/chat/completions", {
  body: {
    messages: [{ role: "user", content: "Summarize record for SSN 123-45-6789" }],
  },
});

// This passes all policies
await meridian.provider("openai")!.post("/v1/chat/completions", {
  body: {
    tenantId:     "tenant_abc",
    consentGiven: true,
    messages: [{ role: "user", content: "Summarize Q3 revenue trends." }],
  },
});
```
