# Meridian Roadmap

Future direction for the Meridian SDK — covering Indian and international provider coverage, SDK-level capabilities, and compliance primitives.

---

## Current State (v0.1.3)

### Built-in Adapters

| Provider | Category | Status |
|---|---|---|
| GitHub | Developer Tools | ✅ Stable |
| Anthropic | AI/LLM | ✅ Stable |
| OpenAI | AI/LLM | ✅ Stable |
| Stripe | Payments | ✅ Stable |
| Razorpay | Payments (India) | ✅ Stable |
| Cashfree | Payments (India) | 🚧 Registered |
| PayU | Payments (India) | 🚧 Registered |
| Juspay | Payments (India) | 🚧 Registered |
| MSG91 | Communications (India) | 🚧 Registered |
| Exotel | Communications (India) | 🚧 Registered |
| Gupshup | Communications (India) | 🚧 Registered |
| Setu | Banking/Fintech (India) | 🚧 Registered |
| Decentro | Banking/Fintech (India) | 🚧 Registered |
| Perfios | Financial Data (India) | 🚧 Registered |
| Shiprocket | Logistics (India) | 🚧 Registered |
| Delhivery | Logistics (India) | 🚧 Registered |
| HyperVerge | KYC/Identity (India) | 🚧 Registered |
| Digio | eSign/KYC (India) | 🚧 Registered |
| Karza | KYC/Verification (India) | 🚧 Registered |
| IDfy | KYC/Identity (India) | 🚧 Registered |
| Cleartax | Tax/Compliance (India) | 🚧 Registered |
| MapMyIndia | Maps/Geo (India) | 🚧 Registered |

> **Legend**: ✅ Adapter implemented and tested · 🚧 Registered in registry, adapter not yet built · 📋 Planned

---

## Phase 1 — Complete Registered Adapters (Near-term)

All providers listed as 🚧 above need full adapter implementations. Priority order within each category:

### Payments (India)

**Cashfree** — Fastest growing Indian payment gateway; strong API for payouts, auto-collect, and account verification.
- Auth: `client_id` + `client_secret` (Bearer token exchange)
- Key endpoints: orders, payments, refunds, payouts, beneficiaries
- Pagination: offset-based (`page`, `limit`)
- Idempotency: `x-idempotency-key` header

**Juspay** — Dominates mobile checkout (PhonePe, Amazon Pay, Flipkart use it); critical for apps targeting Indian consumers.
- Auth: Basic auth with `merchant_id`
- Key endpoints: orders, payment methods, refunds
- Pagination: cursor-based

**PayU** — Strong in BFSI and e-commerce; supports EMI, BNPL, net banking extensively.
- Auth: `merchant_key` + HMAC-SHA512 signature per request
- Key endpoints: payment initiation, verify, refund, settlement
- Note: Signature-based auth requires per-request HMAC — adapter must implement `buildRequest` signing

### Communications (India)

**MSG91** — Market leader for OTP and transactional SMS in India.
- Auth: `authkey` header
- Key endpoints: send SMS, OTP send/verify, email, WhatsApp
- Rate limits: well-documented per-plan

**Exotel** — Cloud telephony; used by Swiggy, Ola, Zomato for call masking and IVR.
- Auth: Basic auth (`api_key:api_token`)
- Key endpoints: calls, SMS, virtual numbers

**Gupshup** — Leading WhatsApp Business API provider in India.
- Auth: `apikey` header
- Key endpoints: messages, templates, opt-in management

### Banking / Fintech (India)

**Setu** — NPCI-licensed AA (Account Aggregator) and UPI infrastructure provider.
- Auth: JWT with client credentials
- Key endpoints: AA consent flow, data fetch, UPI deep links, BillPay BBPS

**Decentro** — Core banking API aggregator; covers KYC, payments, lending, collections.
- Auth: `client_id` + `client_secret` → Bearer token
- Key endpoints: bank account verification, UPI, virtual accounts, KYC

### Logistics (India)

**Shiprocket** — Aggregates 17+ couriers; largest D2C logistics platform in India.
- Auth: email + password → JWT token (with refresh)
- Key endpoints: orders, shipments, tracking, NDR, returns

**Delhivery** — Enterprise logistics; dominates B2B and large-volume D2C.
- Auth: Bearer token
- Key endpoints: shipments, waybills, tracking, COD reconciliation

### KYC / Identity (India)

**HyperVerge** — AI-powered face match, liveness, and document OCR.
- Auth: `appId` + `appKey` headers
- Key endpoints: ID verification, face match, liveness check

**Digio** — eSign and eStamp; RBI-regulated digital signature flow.
- Auth: `client_id` + `client_secret` Basic auth
- Key endpoints: document upload, sign request, status

**Karza** — PAN, GST, Aadhaar, bank account, and business verification.
- Auth: `x-karza-key` header
- Key endpoints: PAN verify, GST details, bank account verify, ITR verify

**IDfy** — End-to-end onboarding; background checks and document verification.
- Auth: `account_id` + `api_key` Basic auth
- Key endpoints: workflows, identity checks, background verification

### Tax / Compliance (India)

**Cleartax** — GST filing, e-invoicing (IRN generation), and TDS compliance.
- Auth: Bearer token (OAuth2 client credentials)
- Key endpoints: GSTR-1, GSTR-3B, e-invoice IRN, e-way bill

### Maps / Geo (India)

**MapMyIndia (Mappls)** — India's authoritative mapping platform; OLA Maps is built on it.
- Auth: OAuth2 client credentials → Bearer token
- Key endpoints: geocode, reverse geocode, directions, places search, distance matrix

---

## Phase 2 — High-Priority New Providers

### Indian Space

#### Payments & UPI

| Provider | Why It Matters |
|---|---|
| **BillDesk** | Dominates enterprise bill payments and government collections; mandatory for BFSI |
| **CCAvenue** | 80%+ SMB market reach; required for mass-market e-commerce integrations |
| **Instamojo** | Freelancer and small business payments; strong link-based payment UX |
| **PayTM Payment Gateway** | Still significant for Tier-2/3 cities and existing PayTM user base |
| **PhonePe Business APIs** | Required for direct UPI-intent flows in consumer apps |

#### Banking & Lending

| Provider | Why It Matters |
|---|---|
| **Signzy** | KYC + bank account verification + video KYC; RBI-compliant onboarding stack |
| **Bureau.id** | Real-time fraud and risk scoring; used by fintechs for credit decisioning |
| **FinBox** | Embedded lending APIs; bank statement analysis + credit model for NBFCs |
| **Experian India** | Credit bureau; mandatory for NBFC/lending apps under RBI guidelines |
| **CRIF High Mark** | Second major credit bureau; required for comprehensive bureau pull coverage |
| **NSDL e-Gov** | PAN verification and TAN services direct from NSDL |

#### GST / Tax

| Provider | Why It Matters |
|---|---|
| **Masters India** | GST intelligence, HSN lookup, and e-invoicing; strong API with better uptime than Cleartax |
| **GSTN APIs (direct)** | Direct taxpayer APIs for GSTR fetch, GSTIN validation without intermediary |

#### Communications

| Provider | Why It Matters |
|---|---|
| **Kaleyra** | Enterprise SMS and WhatsApp; strong presence in banking notifications |
| **Netcore Cloud** | Email + SMS + push notifications; popular in e-commerce and EdTech |
| **Plivo** | Voice + SMS with Indian DLT compliance built-in |
| **ValueFirst** | SMS aggregator used by banks and insurance companies |

#### Logistics

| Provider | Why It Matters |
|---|---|
| **Bluedart (DHL)** | Premium express delivery; required for high-value and enterprise shipments |
| **Ekart (Flipkart)** | Open-network logistics for D2C brands leveraging ONDC |
| **Ecom Express** | Strong Tier-2/3 reach; popular with fashion and lifestyle D2C brands |
| **XpressBees** | High-growth logistics platform popular with quick-commerce integrations |

#### eSign / Government

| Provider | Why It Matters |
|---|---|
| **DigiLocker APIs** | Government-issued document verification (Aadhaar, driving licence, RC) |
| **UIDAI eKYC** | Aadhaar-based KYC; mandatory for regulated financial onboarding |
| **Leegality** | eSign and digital agreements; popular with LegalTech and BFSI workflows |

#### Infrastructure

| Provider | Why It Matters |
|---|---|
| **Tata Communications APIs** | Enterprise connectivity and cloud communications for large Indian enterprises |
| **OLA Maps** | Built on MapMyIndia; growing alternative with better pricing for startups |

### International Space

#### Payments

| Provider | Why It Matters |
|---|---|
| **Adyen** | Preferred gateway for Indian SaaS companies selling globally; unified commerce |
| **Braintree / PayPal** | Required for US/EU consumer-facing apps; PayPal Checkout ubiquity |
| **Checkout.com** | Strong MENA and European coverage; popular with Indian unicorn international expansions |
| **Mollie** | European payments; required for Dutch/German market penetration |
| **Klarna** | BNPL leader in Europe and US; increasingly expected in checkout flows |

#### Communications

| Provider | Why It Matters |
|---|---|
| **Twilio** | Global SMS/voice standard; used by almost every Indian startup for international users |
| **SendGrid** | Transactional email standard; high deliverability for OTP and billing emails |
| **Mailgun** | Developer-first transactional email; popular in B2B SaaS |
| **Vonage (Nexmo)** | Voice API leader; required for call center and telephony integrations |

#### AI / ML

| Provider | Why It Matters |
|---|---|
| **Cohere** | Enterprise LLM with strong RAG capabilities; growing in Indian enterprise AI adoption |
| **Mistral** | Open-weight models with EU data residency; required for European deployments |
| **HuggingFace Inference API** | Access to 100k+ models; essential for ML-heavy applications |
| **Stability AI** | Image generation APIs; used in content creation and e-commerce product imagery |
| **Google Gemini (Vertex AI)** | Strong in India via Google Cloud; required for GCP-native stacks |

#### CRM / Business Tools

| Provider | Why It Matters |
|---|---|
| **Freshworks** | Indian company (Chennai); Freshdesk + Freshsales APIs are widely used by Indian SaaS |
| **HubSpot** | CRM standard for B2B SaaS; marketing automation and contact management |
| **Salesforce** | Enterprise CRM; required for large-deal B2B integrations |
| **Zendesk** | Customer support standard; high demand from D2C and SaaS companies |

#### Auth & Identity

| Provider | Why It Matters |
|---|---|
| **Auth0 / Okta** | Identity-as-a-service standard; required when building multi-tenant SaaS |
| **Firebase Auth** | Popular for mobile apps; strong in Indian startup ecosystem |

#### Monitoring & Observability

| Provider | Why It Matters |
|---|---|
| **Sentry** | Error tracking standard; every production application needs it |
| **Datadog** | APM and infrastructure monitoring; required for enterprise deployments |
| **New Relic** | Alternative APM; strong in US enterprise market |

#### Storage & Database

| Provider | Why It Matters |
|---|---|
| **AWS S3 / CloudFront** | Object storage is a primitive for KYC document pipelines |
| **Cloudflare R2** | S3-compatible storage with no egress fees; growing in Indian startup infrastructure |
| **Supabase** | Postgres-as-a-service with storage; popular in Indian indie dev community |

---

## Phase 3 — SDK Capabilities

Beyond provider coverage, these SDK-level features have the highest return:

### Webhook Signature Verification

Every payment and communication provider sends webhooks with HMAC signatures. Meridian should expose a `verifyWebhook` utility per adapter so users never re-implement HMAC-SHA256 validation:

```typescript
// Proposed API
import { RazorpayAdapter } from "meridianjs";

const adapter = new RazorpayAdapter();
const isValid = adapter.verifyWebhook({
  payload: req.body,
  signature: req.headers["x-razorpay-signature"],
  secret: process.env.RAZORPAY_WEBHOOK_SECRET,
});
```

**Priority:** High — Razorpay, Cashfree, Stripe, MSG91, Shiprocket all use HMAC-based webhook verification.

### Streaming Response Support

Required for OpenAI and Anthropic chat completions (SSE streams). The current pipeline assumes request/response. A `stream()` method on `ProviderClient` is needed:

```typescript
// Proposed API
for await (const chunk of meridian.provider("openai").stream("/v1/chat/completions", { ... })) {
  process.stdout.write(chunk.data.choices[0].delta.content);
}
```

### Mock / Sandbox Adapter

A `MockAdapter` that intercepts calls without making network requests — critical for payment and KYC adapters where sandbox environments have rate limits:

```typescript
// Proposed API
import { MockAdapter } from "meridianjs/testing";

const mock = new MockAdapter("razorpay")
  .onPost("/v1/orders").reply(200, { id: "order_test_123" })
  .onGet("/v1/payments/:id").reply(200, { status: "captured" });
```

### Batch Operations

Multiple Indian APIs (Razorpay, Setu, Decentro) support bulk requests. A `batch()` method that fans out with rate-limit awareness:

```typescript
// Proposed API
const results = await meridian.provider("razorpay").batch([
  { method: "GET", endpoint: "/v1/payments/pay_1" },
  { method: "GET", endpoint: "/v1/payments/pay_2" },
]);
```

### India Compliance Mode (`IndiaCompliance`)

DPDPA (Digital Personal Data Protection Act, 2023) requires specific PII handling. A built-in compliance mode that auto-redacts Aadhaar numbers, PAN, bank account numbers, and VPAs from all observability paths:

```typescript
// Proposed API
const meridian = await Meridian.create({
  compliance: {
    piiRedaction: true,
    indiaMode: true, // Redacts Aadhaar, PAN, UPI VPA, account numbers
  },
  ...
});
```

### UPI Flow Helpers

UPI is a uniquely Indian primitive. High-level helpers for common UPI patterns on top of raw adapters:

```typescript
// Proposed API (built on top of Setu/Decentro adapters)
import { createUpiDeepLink, validateVpa } from "meridianjs/upi";

const link = createUpiDeepLink({ vpa: "merchant@upi", amount: 1000, note: "Order #123" });
const isValid = await validateVpa("user@oksbi", meridian);
```

### OpenAPI Spec Generation

Auto-generate OpenAPI specs from configured providers and their used endpoints. Useful for internal documentation and API gateway configuration.

### GraphQL Support

Low priority for v1, but increasingly needed as GitHub's v4 API, Shopify, and other providers move to GraphQL.

---

## Phase 4 — Ecosystem

- **`@meridian/react`** — React hooks (`useQuery`, `useMutation`) wrapping Meridian client methods with loading/error state
- **`@meridian/nest`** — NestJS module for injecting Meridian providers as services
- **`@meridian/next`** — Next.js API route helpers with automatic Meridian context
- **Meridian Cloud** — Hosted proxy for teams who want Meridian's normalization layer without self-hosting
- **Provider Registry** — Community-contributed adapter registry (publish adapters as npm packages following `meridian-adapter-*` convention)
- **CLI** — `npx meridian probe <provider>` to test connectivity, check rate limits, and validate credentials

---

## Contributing a New Adapter

The fastest path to adding a provider:

1. Create `src/providers/<name>/pagination.ts` — implement `PaginationStrategy`
2. Create `src/providers/<name>/adapter.ts` — implement `ProviderAdapter`
3. Create `src/providers/<name>/index.ts` — re-export both
4. Create `src/providers/<name>/adapter.test.ts` — contract tests (see `github/adapter.test.ts` as the reference)
5. Register in `src/index.ts` `BUILTIN_ADAPTER_CLASSES`
6. Export from `src/public.ts`
7. Add `provider(name: "<name>")` overload in `src/index.ts`

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## Version Targets

| Version | Target | Focus |
|---|---|---|
| **v0.1.x** (current) | Q2 2026 | Razorpay stable; registered adapters scaffolded |
| **v0.2.0** | Q3 2026 | All 17 registered adapters implemented and tested |
| **v0.3.0** | Q3 2026 | Phase 2 Indian providers (BillDesk, Twilio, Signzy, Bureau.id) |
| **v0.4.0** | Q4 2026 | Webhook verification utilities across all payment adapters |
| **v0.5.0** | Q4 2026 | Streaming support (OpenAI/Anthropic), Mock adapter |
| **v0.6.0** | Q1 2027 | Batch operations, India Compliance Mode, UPI helpers |
| **v1.0.0** | Q2 2027 | Stable API contract, full international provider set, ecosystem packages |
