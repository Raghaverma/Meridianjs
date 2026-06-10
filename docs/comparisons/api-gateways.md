# Meridian vs. API Gateways

This comparison comes up because both "API gateway" and "Meridian" sound like they sit in the middle of a request. But they sit in the middle of *different* requests, going in *opposite directions*.

```
                 ┌────────────────┐
  Clients  ───▶  │   API Gateway   │  ───▶  Your services
 (inbound)       │  (Kong, Apigee, │
                  │  AWS API GW)    │
                  └────────────────┘

                 ┌────────────────┐
Your app  ───▶  │    Meridian     │  ───▶  OpenAI, Stripe, Razorpay, ...
 (outbound)      │ (in-process)   │
                 └────────────────┘
```

An API gateway manages **north-south traffic into your services**: authenticating external clients, rate-limiting them, routing to the right backend, applying WAF rules.

Meridian manages **traffic out of your application to third-party APIs**: the calls *you* make to OpenAI, Stripe, Razorpay, Twilio, and 40+ other vendors.

## The comparison

| Concern | API Gateway | Meridian |
|---|---|---|
| Traffic direction | Inbound — clients calling your API | Outbound — your app calling third-party APIs |
| Deployment | Separate infrastructure (proxy, load balancer, managed service) | npm package — runs in-process inside your application |
| Authenticates *your* API's consumers | ✅ | ❌ (not its job) |
| Normalizes *third-party* response/error shapes | ❌ | ✅ — `MeridianError`, `meta.rateLimit`, `meta.pagination` |
| Multi-vendor failover (e.g. OpenAI → Anthropic, Stripe → Razorpay) | ❌ | ✅ |
| Circuit breakers on upstream vendors | ❌ (gateways breaker your services, not third-party APIs you call) | ✅ |
| Schema drift detection on vendor responses | ❌ | ✅ |
| Rate limiting | ✅ — limits inbound clients hitting you | ✅ — but for outbound calls *you* make to vendors, respecting *their* limits |
| Policy enforcement | ✅ — auth, WAF rules, request validation for inbound traffic | ✅ — PII blocking, redaction, region rules for outbound payloads |
| Adds a network hop | Yes, by design (it's the front door) | No — it's a library, not a proxy |

## Why this confusion happens

Both tools use the vocabulary of "rate limiting," "policies," and "routing" — because both are, at their core, request-pipeline systems. The difference is *whose* requests:

- An API gateway sits between **the internet and your backend**. It protects *you* from *your callers*.
- Meridian sits between **your backend and the internet**. It protects *you* from *your dependencies*.

You can — and many production systems do — use both at the same time, for different halves of the same request:

```
Mobile App ──▶ API Gateway ──▶ Your Backend ──▶ Meridian ──▶ Stripe / OpenAI / Razorpay
              (inbound)                          (outbound)
```

## What this looks like in code

Meridian doesn't run as a separate process or require deployment changes. It's a dependency your backend imports:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    stripe: { auth: { apiKey: process.env.STRIPE_KEY! } },
    razorpay: { auth: { username: process.env.RAZORPAY_KEY!, password: process.env.RAZORPAY_SECRET! } },
  },
  services: {
    payments: { providers: ["stripe", "razorpay"], strategy: "geo", regions: { "us-east-1": ["stripe"], "ap-south-1": ["razorpay"] } },
  },
});

// Your backend's own API gateway has already authenticated this inbound request.
// This outbound call to a payment provider gets retries, circuit breaking,
// failover, and normalized errors — with zero gateway infrastructure involved.
const { data, meta } = await meridian.service("payments")!.post("/charges", { body: { amount: 2000 } });
```

## The short version

If your mental model is "Meridian is a gateway," the question to ask is: **gateway for whose traffic?** API gateways protect your services from the outside world. Meridian protects your application from the third-party services it depends on. They're complementary layers, not competitors — most production systems that have one will eventually want the other.
